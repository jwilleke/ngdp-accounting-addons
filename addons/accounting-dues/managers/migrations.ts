/**
 * The dues database's migration ledger: a database of the accounting-dues
 * add-on's own (D-035), never the accounting add-on's. Each entry is a frozen
 * snapshot; a change is a new, later entry. Every table starts with
 * `accounting_dues_`.
 */
export interface MigrationDb { exec(sql: string): unknown }
export interface DuesMigration { id: string; description: string; up: (db: MigrationDb) => void }

export const DUES_LEDGER_TABLE = 'accounting_dues_schema_migrations';

const INVOICES: DuesMigration = {
  id: '20261021180000',
  description: 'invoices and their lines, outside the ledger (D-035)',
  up: (db) => {
    db.exec(`
      -- I-0001 onwards: one sequence per site, at least four digits, no upper limit.
      CREATE TABLE accounting_dues_sequence (
        name  TEXT PRIMARY KEY,
        next  INTEGER NOT NULL CHECK (next >= 1)
      );
      INSERT INTO accounting_dues_sequence (name, next) VALUES ('invoice', 1);

      -- An invoice: one account's charges for one month, kept exactly as issued. Not money, so
      -- not in the ledger; a payment is a receipt line naming the account. A mistake is voided,
      -- with a reason, and issued again.
      CREATE TABLE accounting_dues_invoices (
        id              TEXT PRIMARY KEY,
        number          TEXT NOT NULL UNIQUE,
        account_id      TEXT NOT NULL,
        account_label   TEXT NOT NULL,
        month           TEXT NOT NULL,
        date            TEXT NOT NULL,
        due_date        TEXT NOT NULL,
        total           INTEGER NOT NULL CHECK (total >= 0),
        previous        INTEGER NOT NULL,
        owed            INTEGER NOT NULL CHECK (owed >= 0),
        owners          TEXT NOT NULL,
        html            TEXT NOT NULL,
        sha256          TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('issued', 'voided')),
        void_reason     TEXT,
        emailed_to      TEXT,
        emailed_at      TEXT,
        created_by      TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        CHECK (status <> 'voided' OR (void_reason IS NOT NULL AND void_reason <> ''))
      );
      CREATE UNIQUE INDEX accounting_dues_invoices_month ON accounting_dues_invoices (account_id, month) WHERE status = 'issued';
      CREATE TRIGGER accounting_dues_invoices_no_delete BEFORE DELETE ON accounting_dues_invoices
      BEGIN SELECT RAISE(ABORT, 'dues: an invoice is voided, never deleted'); END;
      -- Only two changes: voided once, with a reason; the email recorded once.
      CREATE TRIGGER accounting_dues_invoices_fixed BEFORE UPDATE ON accounting_dues_invoices
      WHEN NEW.id IS NOT OLD.id OR NEW.number IS NOT OLD.number OR NEW.account_id IS NOT OLD.account_id
        OR NEW.account_label IS NOT OLD.account_label OR NEW.month IS NOT OLD.month OR NEW.date IS NOT OLD.date
        OR NEW.due_date IS NOT OLD.due_date OR NEW.total IS NOT OLD.total OR NEW.previous IS NOT OLD.previous
        OR NEW.owed IS NOT OLD.owed OR NEW.owners IS NOT OLD.owners OR NEW.html IS NOT OLD.html OR NEW.sha256 IS NOT OLD.sha256
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
        OR (NEW.status IS NOT OLD.status AND NOT (OLD.status = 'issued' AND NEW.status = 'voided'
              AND NEW.void_reason IS NOT NULL AND NEW.void_reason <> ''))
        OR (NEW.emailed_at IS NOT OLD.emailed_at AND OLD.emailed_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'dues: an issued invoice never changes; void it and issue it again'); END;

      -- A charge on an invoice: the month's dues or assessment, or a late charge on an earlier
      -- invoice (applies_to), keyed so the same late charge is never made twice.
      CREATE TABLE accounting_dues_invoice_lines (
        id              TEXT PRIMARY KEY,
        invoice_id      TEXT NOT NULL REFERENCES accounting_dues_invoices (id),
        position        INTEGER NOT NULL,
        kind            TEXT NOT NULL CHECK (kind IN ('charge', 'late-charge')),
        description     TEXT NOT NULL,
        amount          INTEGER NOT NULL CHECK (amount > 0),
        category        TEXT NOT NULL,
        rule_id         TEXT,
        applies_to      TEXT,
        charge_key      TEXT,
        CHECK (kind <> 'late-charge' OR (rule_id IS NOT NULL AND applies_to IS NOT NULL AND charge_key IS NOT NULL))
      );
      CREATE INDEX accounting_dues_invoice_lines_invoice ON accounting_dues_invoice_lines (invoice_id);
      CREATE TRIGGER accounting_dues_invoice_lines_fixed BEFORE UPDATE ON accounting_dues_invoice_lines
      BEGIN SELECT RAISE(ABORT, 'dues: an invoice line never changes'); END;
      CREATE TRIGGER accounting_dues_invoice_lines_no_delete BEFORE DELETE ON accounting_dues_invoice_lines
      BEGIN SELECT RAISE(ABORT, 'dues: an invoice line is never deleted'); END;
    `);
  }
};

export const DUES_MIGRATIONS: DuesMigration[] = [INVOICES];
