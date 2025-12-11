/**
 * Utilities for converting datasource names to DuckDB database identifiers
 *
 * DuckDB database names must be valid identifiers. This module provides
 * functions to sanitize datasource names for use as database names in ATTACH statements.
 */

/**
 * Sanitize a datasource name to be a valid DuckDB database identifier
 * - Replaces invalid characters with underscores
 * - Ensures it starts with a letter (adds prefix if needed)
 * - Converts to lowercase for consistency
 * - Removes leading/trailing whitespace
 *
 * @param name - The datasource name to sanitize
 * @returns A valid DuckDB database identifier
 */
export function sanitizeDatabaseName(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new Error('Datasource name must be a non-empty string');
  }

  // Trim whitespace
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Datasource name cannot be empty');
  }

  // Replace invalid characters (anything not alphanumeric or underscore) with underscore
  // DuckDB allows letters, numbers, and underscores in identifiers
  let cleaned = trimmed.replace(/[^a-zA-Z0-9_]/g, '_');

  // Remove consecutive underscores
  cleaned = cleaned.replace(/_+/g, '_');

  // Remove leading/trailing underscores
  cleaned = cleaned.replace(/^_+|_+$/g, '');

  // Ensure it starts with a letter (DuckDB requirement)
  if (!/^[a-zA-Z]/.test(cleaned)) {
    cleaned = `db_${cleaned}`;
  }

  // Convert to lowercase for consistency
  cleaned = cleaned.toLowerCase();

  // Ensure it's not empty after sanitization
  if (!cleaned) {
    throw new Error(
      'Datasource name resulted in empty identifier after sanitization',
    );
  }

  return cleaned;
}

/**
 * Get the database name for a datasource attachment
 * Uses the datasource name directly (sanitized) as the database name
 *
 * @param datasource - The datasource entity
 * @returns The sanitized database name to use in ATTACH statements
 */
export function getDatasourceDatabaseName(datasource: {
  name: string;
  id?: string;
}): string {
  if (!datasource.name) {
    throw new Error('Datasource must have a name');
  }

  return sanitizeDatabaseName(datasource.name);
}
