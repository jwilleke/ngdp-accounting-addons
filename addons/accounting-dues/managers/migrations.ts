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

const BILLING_PARTIES: DuesMigration = {
  id: '20261023120000',
  description: 'one invoice per billing party, each party with its own balance (D-038, D-040)',
  up: (db) => {
    db.exec(`
      -- The party billed: its people's ngdpbase usernames, sorted and joined with commas; its names
      -- as billed; and the address the invoice went to (schema.org PostalAddress, JSON).
      ALTER TABLE accounting_dues_invoices ADD COLUMN party TEXT NOT NULL DEFAULT '';
      ALTER TABLE accounting_dues_invoices ADD COLUMN party_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE accounting_dues_invoices ADD COLUMN address TEXT;
      -- Invoices issued before parties: the party is every owner the invoice named.
      UPDATE accounting_dues_invoices SET
        party = COALESCE((SELECT group_concat(u, ',') FROM (SELECT json_extract(value, '$.username') AS u FROM json_each(owners) ORDER BY u)), ''),
        party_name = COALESCE((SELECT group_concat(n, ', ') FROM (SELECT json_extract(value, '$.name') AS n FROM json_each(owners))), '');

      DROP INDEX accounting_dues_invoices_month;
      CREATE UNIQUE INDEX accounting_dues_invoices_month ON accounting_dues_invoices (account_id, party, month) WHERE status = 'issued';
      DROP TRIGGER accounting_dues_invoices_fixed;
      CREATE TRIGGER accounting_dues_invoices_fixed BEFORE UPDATE ON accounting_dues_invoices
      WHEN NEW.id IS NOT OLD.id OR NEW.number IS NOT OLD.number OR NEW.account_id IS NOT OLD.account_id
        OR NEW.account_label IS NOT OLD.account_label OR NEW.month IS NOT OLD.month OR NEW.date IS NOT OLD.date
        OR NEW.due_date IS NOT OLD.due_date OR NEW.total IS NOT OLD.total OR NEW.previous IS NOT OLD.previous
        OR NEW.owed IS NOT OLD.owed OR NEW.owners IS NOT OLD.owners OR NEW.html IS NOT OLD.html OR NEW.sha256 IS NOT OLD.sha256
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
        OR NEW.party IS NOT OLD.party OR NEW.party_name IS NOT OLD.party_name OR NEW.address IS NOT OLD.address
        OR (NEW.status IS NOT OLD.status AND NOT (OLD.status = 'issued' AND NEW.status = 'voided'
              AND NEW.void_reason IS NOT NULL AND NEW.void_reason <> ''))
        OR (NEW.emailed_at IS NOT OLD.emailed_at AND OLD.emailed_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'dues: an issued invoice never changes; void it and issue it again'); END;
    `);
  }
};

const INVOICE_PDF: DuesMigration = {
  id: '20261025090000',
  description: "the fingerprint of the PDF an invoice was emailed as (#51)",
  up: (db) => {
    db.exec(`
      -- The SHA-256 of the PDF attached when the invoice was emailed; null when it went as the page alone.
      ALTER TABLE accounting_dues_invoices ADD COLUMN pdf_sha256 TEXT;
      DROP TRIGGER accounting_dues_invoices_fixed;
      CREATE TRIGGER accounting_dues_invoices_fixed BEFORE UPDATE ON accounting_dues_invoices
      WHEN NEW.id IS NOT OLD.id OR NEW.number IS NOT OLD.number OR NEW.account_id IS NOT OLD.account_id
        OR NEW.account_label IS NOT OLD.account_label OR NEW.month IS NOT OLD.month OR NEW.date IS NOT OLD.date
        OR NEW.due_date IS NOT OLD.due_date OR NEW.total IS NOT OLD.total OR NEW.previous IS NOT OLD.previous
        OR NEW.owed IS NOT OLD.owed OR NEW.owners IS NOT OLD.owners OR NEW.html IS NOT OLD.html OR NEW.sha256 IS NOT OLD.sha256
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
        OR NEW.party IS NOT OLD.party OR NEW.party_name IS NOT OLD.party_name OR NEW.address IS NOT OLD.address
        OR (NEW.status IS NOT OLD.status AND NOT (OLD.status = 'issued' AND NEW.status = 'voided'
              AND NEW.void_reason IS NOT NULL AND NEW.void_reason <> ''))
        OR (NEW.emailed_at IS NOT OLD.emailed_at AND OLD.emailed_at IS NOT NULL)
        OR (NEW.pdf_sha256 IS NOT OLD.pdf_sha256 AND OLD.emailed_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'dues: an issued invoice never changes; void it and issue it again'); END;
    `);
  }
};

const IDENTITY_BILLING: DuesMigration = {
  id: '20261025150000',
  description: 'invoices go to billing addresses; the owners who owe are named by identity @id (D-047, ngdpbase#2042)',
  up: (db) => {
    db.exec(`
      -- Where the invoice went, as typed by the treasurer or the owners; and the unit's owners at that date,
      -- [{ "@id", "share" }] JSON: no names. Null on invoices issued before, which keep their party as it was.
      ALTER TABLE accounting_dues_invoices ADD COLUMN billing_address TEXT;
      ALTER TABLE accounting_dues_invoices ADD COLUMN owner_ids TEXT;
      DROP TRIGGER accounting_dues_invoices_fixed;
      CREATE TRIGGER accounting_dues_invoices_fixed BEFORE UPDATE ON accounting_dues_invoices
      WHEN NEW.id IS NOT OLD.id OR NEW.number IS NOT OLD.number OR NEW.account_id IS NOT OLD.account_id
        OR NEW.account_label IS NOT OLD.account_label OR NEW.month IS NOT OLD.month OR NEW.date IS NOT OLD.date
        OR NEW.due_date IS NOT OLD.due_date OR NEW.total IS NOT OLD.total OR NEW.previous IS NOT OLD.previous
        OR NEW.owed IS NOT OLD.owed OR NEW.owners IS NOT OLD.owners OR NEW.html IS NOT OLD.html OR NEW.sha256 IS NOT OLD.sha256
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
        OR NEW.party IS NOT OLD.party OR NEW.party_name IS NOT OLD.party_name OR NEW.address IS NOT OLD.address
        OR NEW.billing_address IS NOT OLD.billing_address OR NEW.owner_ids IS NOT OLD.owner_ids
        OR (NEW.status IS NOT OLD.status AND NOT (OLD.status = 'issued' AND NEW.status = 'voided'
              AND NEW.void_reason IS NOT NULL AND NEW.void_reason <> ''))
        OR (NEW.emailed_at IS NOT OLD.emailed_at AND OLD.emailed_at IS NOT NULL)
        OR (NEW.pdf_sha256 IS NOT OLD.pdf_sha256 AND OLD.emailed_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'dues: an issued invoice never changes; void it and issue it again'); END;
    `);
  }
};

export const DUES_MIGRATIONS: DuesMigration[] = [INVOICES, BILLING_PARTIES, INVOICE_PDF, IDENTITY_BILLING];
