import { describe, expect, it } from 'vitest';
import { __testables } from '../../src/tools/validate-remediation-in-gfs-cli';

describe('validate_remediation_in_gfs_cli helpers', () => {
  it('parses PostgreSQL major versions from client banners', () => {
    expect(
      __testables.parsePostgresClientMajorVersion('pg_dump (PostgreSQL) 18.1'),
    ).toBe('18');
    expect(
      __testables.parsePostgresClientMajorVersion(
        'psql (PostgreSQL) 16.8 (Debian 16.8-1.pgdg120+1)',
      ),
    ).toBe('16');
  });

  it('parses abbreviated commit hashes from gfs log output', () => {
    expect(
      __testables.parseCommitHash(
        'commit fe7c2f7 (HEAD -> main, main)\nAuthor: test <test@example.com>',
      ),
    ).toBe('fe7c2f7');
  });

  it('builds version-aware binary candidates before generic fallbacks', () => {
    expect(__testables.buildVersionedBinaryCandidates('pg_dump', '16')).toEqual(
      [
        'pg_dump-16',
        'pg_dump16',
        '/usr/lib/postgresql/16/bin/pg_dump',
        '/usr/pgsql-16/bin/pg_dump',
        '/opt/homebrew/opt/libpq@16/bin/pg_dump',
        '/usr/local/opt/libpq@16/bin/pg_dump',
      ],
    );
  });

  it('includes generic and versioned bootstrap candidates', () => {
    const candidates = __testables.buildBootstrapBinaryCandidates('psql');

    expect(candidates[0]).toBe('psql');
    expect(candidates).toContain('/usr/bin/psql');
    expect(candidates).toContain('/usr/lib/postgresql/16/bin/psql');
    expect(candidates).toContain('/usr/pgsql-16/bin/psql');
  });
});
