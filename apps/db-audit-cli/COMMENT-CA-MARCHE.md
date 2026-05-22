# Comment fonctionne `db-audit` (pour les profils SQL)

Tu lui donnes une URL Postgres et un `pg_dump` au format plain. Il lance
des diagnostics en lecture seule sur la base live, puis teste les remédiations
retenues sur un clone jetable du dump via GFS. Les recommandations finales sont
limitées aux actions validées, ou explicitement marquées comme non validées /
bloquées. La base d'origine n'est jamais modifiée.

## Ce que tu fournis

- **URL** Postgres (un rôle en lecture seule suffit).
- **Dump SQL plain** créé avec `pg_dump --format=plain --no-owner
  --no-privileges`. Les dumps `--format=custom` sont refusés (le
  validateur a besoin de `psql` pour les rejouer).

## Ce que fait la commande `audit`

1. **Diagnostic (live, read-only).** Le CLI interroge
   `pg_stat_statements`, `pg_stat_user_indexes/tables`, `pg_locks`,
   la réplication, les cibles de statistiques, les estimateurs de bloat,
   les logs récents, et fait `EXPLAIN (ANALYZE, BUFFERS)` sur les
   requêtes suspectes.
2. **Tri.** Il garde les findings à plus fort impact latence/IO.
3. **Validation sur clone.** Pour chaque candidat retenu, dans la limite de
   `--max-validations`, il appelle `gfs` pour charger ton dump dans une branche
   Postgres locale, appliquer le correctif (`CREATE INDEX`, `ANALYZE`,
   `VACUUM`, réglage de session, réécriture…), relancer la requête de validation
   ou `EXPLAIN (ANALYZE, BUFFERS)`, puis conserver les métadonnées GFS. Une
   action n'est recommandée que si la validation la classe comme `validated`.
   Les actions non validées restent bloquées ou en hypothèse.
4. **Rapport.** Un Markdown contenant les findings, le SQL qui les
   prouve, les métriques/plans avant-après, le SQL de remédiation, le rollback
   quand il existe, les commandes de restauration GFS, et les caveats.

## Options de `db-audit audit`

| Option | Rôle | Valeur recommandée |
|---|---|---|
| `--url` | URL Postgres de la base à auditer. **Obligatoire.** | Un compte read-only sur la base cible. Évite `postgres`/superuser. |
| `--dump` | Chemin vers un dump SQL plain de cette base. | Un `pg_dump --format=plain` récent. Les diagnostics viennent de la base live ; le dump sert à rejouer les validations dans GFS avec des données proches de la cible. Exclusif avec `--dump-dir`. |
| `--dump-dir` | Répertoire contenant un dump nommé `<host>-<port>-<db>.sql` ou `<db>.sql`. | Utile si tu maintiens un dossier partagé de dumps. Exclusif avec `--dump`. |
| `--gfs-audits-dir` | Workdir local pour les clones GFS. | Un disque rapide avec assez d'espace pour plusieurs copies effectives de la base restaurée (souvent 3× à 5× la taille du dump, plus pour les gros dumps), car GFS crée des workspaces et snapshots. |
| `--out` | Chemin du rapport Markdown. | Laisse la valeur par défaut, ou pointe vers ton dossier de rapports d'équipe. |
| `--json` | Chemin du rapport JSON (optionnel). | À activer si tu veux ingérer les résultats dans un autre outil. |
| `--statement-timeout` | Borne par requête de diagnostic, format Postgres (`30s`, `2min`). Défaut `30s`. | `30s` sur OLTP. Monte à `2min`–`5min` si tu as de gros analytiques où un `EXPLAIN ANALYZE` légitime dépasse 30 s. Trop bas = findings manqués ; trop haut = risque sur la prod. |
| `--max-plan-candidates` | Nombre max de findings pour lesquels l'agent propose un correctif. Défaut `3`. | `3` pour un audit ciblé, `5`–`8` pour un audit large. Plus haut = run plus long et plus de tokens. |
| `--max-validations` | Nombre max de correctifs réellement testés sur clone (étape coûteuse). Défaut `3`. | Garde ≤ `--max-plan-candidates`. `3` est un bon point d'équilibre ; chaque validation = un restore complet du dump. |
| `--model` | Identifiant du modèle LLM. | Laisse la valeur par défaut, sauf si tu sais ce que tu changes. |
| `--debug-trace` | Masque l'affichage des outils appelés et garde les traces brutes. | Off, sauf debug du CLI lui-même. |

## Commandes

```
db-audit doctor --url <url> (--dump <chemin> | --dump-dir <chemin>)
db-audit audit  --url <url> (--dump <chemin> | --dump-dir <chemin>) [options ci-dessus]
```

Lance `doctor` en premier : il vérifie `gfs`, `psql`, la lisibilité du
dump et la connectivité Postgres avant que tu dépenses du temps (et des
tokens) sur l'audit.

## Ce que ça change pour toi

Chaque affirmation importante est appuyée par des métriques ou une requête que
tu peux rejouer. Les actions recommandées ont été testées sur un clone de tes
données quand c'était possible ; les autres sont explicitement bloquées ou
marquées comme hypothèses. L'application en prod reste ta décision.
