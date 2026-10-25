/**
 * The donations database's migration ledger: a database of the
 * accounting-donations add-on's own (operator, 2026-10-20), never the
 * accounting add-on's. Each entry is a frozen snapshot; a change is a new,
 * later entry. Every table starts with `accounting_donations_`.
 */
export interface MigrationDb { exec(sql: string): unknown }
export interface DonationsMigration { id: string; description: string; up: (db: MigrationDb) => void }

export const DONATIONS_LEDGER_TABLE = 'accounting_donations_schema_migrations';

const INKIND_AND_PLEDGES: DonationsMigration = {
  id: '20261020140000',
  description: 'in-kind gifts and pledges (D-036)',
  up: (db) => {
    db.exec(`
      -- A gift of goods or services: described, never valued (IRS Publication 1771). Not money, so not in the ledger.
      CREATE TABLE accounting_donations_inkind (
        id              TEXT PRIMARY KEY,
        donor_person_id TEXT,
        donor_name      TEXT NOT NULL,
        date            TEXT NOT NULL,
        description     TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('posted', 'voided')),
        void_reason     TEXT,
        created_by      TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        CHECK (status <> 'voided' OR (void_reason IS NOT NULL AND void_reason <> ''))
      );
      CREATE TRIGGER accounting_donations_inkind_no_delete BEFORE DELETE ON accounting_donations_inkind
      BEGIN SELECT RAISE(ABORT, 'donations: an in-kind gift is voided, never deleted'); END;
      CREATE TRIGGER accounting_donations_inkind_fixed BEFORE UPDATE ON accounting_donations_inkind
      WHEN NEW.id IS NOT OLD.id OR NEW.donor_person_id IS NOT OLD.donor_person_id OR NEW.donor_name IS NOT OLD.donor_name
        OR NEW.date IS NOT OLD.date OR NEW.description IS NOT OLD.description
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
        OR NOT (OLD.status = 'posted' AND NEW.status = 'voided' AND NEW.void_reason IS NOT NULL AND NEW.void_reason <> '')
      BEGIN SELECT RAISE(ABORT, 'donations: an in-kind gift never changes; void it, once, with a reason'); END;

      -- A promise to give, not money yet: kept outside the ledger. Gifts that pay toward it are
      -- receipt lines whose gift details name the pledge.
      CREATE TABLE accounting_donations_pledges (
        id              TEXT PRIMARY KEY,
        donor_person_id TEXT,
        donor_name      TEXT NOT NULL,
        amount          INTEGER NOT NULL CHECK (amount > 0),
        fund_id         TEXT NOT NULL,
        start_date      TEXT NOT NULL,
        end_date        TEXT,
        schedule        TEXT NOT NULL DEFAULT 'once',
        memo            TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL CHECK (status IN ('open', 'cancelled')),
        cancel_reason   TEXT,
        created_by      TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        CHECK (status <> 'cancelled' OR (cancel_reason IS NOT NULL AND cancel_reason <> ''))
      );
      CREATE TRIGGER accounting_donations_pledges_no_delete BEFORE DELETE ON accounting_donations_pledges
      BEGIN SELECT RAISE(ABORT, 'donations: a pledge is cancelled, never deleted'); END;
      CREATE TRIGGER accounting_donations_pledges_fixed BEFORE UPDATE ON accounting_donations_pledges
      WHEN NEW.id IS NOT OLD.id OR NEW.donor_person_id IS NOT OLD.donor_person_id OR NEW.donor_name IS NOT OLD.donor_name
        OR NEW.amount IS NOT OLD.amount OR NEW.fund_id IS NOT OLD.fund_id OR NEW.start_date IS NOT OLD.start_date
        OR NEW.end_date IS NOT OLD.end_date OR NEW.schedule IS NOT OLD.schedule OR NEW.memo IS NOT OLD.memo
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
        OR NOT (OLD.status = 'open' AND NEW.status = 'cancelled' AND NEW.cancel_reason IS NOT NULL AND NEW.cancel_reason <> '')
      BEGIN SELECT RAISE(ABORT, 'donations: a pledge never changes; cancel it, once, with a reason'); END;
    `);
  }
};

const STATEMENTS: DonationsMigration = {
  id: '20261021120000',
  description: 'issued year-end giving statements, kept exactly as sent (D-036)',
  up: (db) => {
    db.exec(`
      -- A year-end giving statement as issued: its page, fingerprint and totals, never changed. A
      -- correction is a new statement; the one it replaces is marked superseded, with the reason.
      CREATE TABLE accounting_donations_statements (
        id              TEXT PRIMARY KEY,
        donor_type      TEXT NOT NULL CHECK (donor_type IN ('person', 'organization')),
        donor_id        TEXT NOT NULL,
        donor_name      TEXT NOT NULL,
        year            INTEGER NOT NULL,
        html            TEXT NOT NULL,
        sha256          TEXT NOT NULL,
        total           INTEGER NOT NULL,
        deductible      INTEGER NOT NULL,
        gift_count      INTEGER NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('issued', 'superseded')),
        superseded_by   TEXT,
        reissue_reason  TEXT,
        emailed_to      TEXT,
        emailed_at      TEXT,
        issued_by       TEXT NOT NULL,
        issued_at       TEXT NOT NULL
      );
      CREATE UNIQUE INDEX accounting_donations_statements_current ON accounting_donations_statements (donor_id, year) WHERE status = 'issued';
      CREATE TRIGGER accounting_donations_statements_no_delete BEFORE DELETE ON accounting_donations_statements
      BEGIN SELECT RAISE(ABORT, 'donations: an issued statement is never deleted'); END;
      -- Only two changes: superseded once (with what replaces it and why), and the email recorded once.
      CREATE TRIGGER accounting_donations_statements_fixed BEFORE UPDATE ON accounting_donations_statements
      WHEN NEW.id IS NOT OLD.id OR NEW.donor_type IS NOT OLD.donor_type OR NEW.donor_id IS NOT OLD.donor_id
        OR NEW.donor_name IS NOT OLD.donor_name OR NEW.year IS NOT OLD.year OR NEW.html IS NOT OLD.html
        OR NEW.sha256 IS NOT OLD.sha256 OR NEW.total IS NOT OLD.total OR NEW.deductible IS NOT OLD.deductible
        OR NEW.gift_count IS NOT OLD.gift_count OR NEW.issued_by IS NOT OLD.issued_by OR NEW.issued_at IS NOT OLD.issued_at
        OR (NEW.status IS NOT OLD.status AND NOT (OLD.status = 'issued' AND NEW.status = 'superseded'
              AND NEW.superseded_by IS NOT NULL AND NEW.reissue_reason IS NOT NULL AND NEW.reissue_reason <> ''))
        OR (NEW.superseded_by IS NOT OLD.superseded_by AND NEW.status = OLD.status)
        OR (NEW.emailed_at IS NOT OLD.emailed_at AND OLD.emailed_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'donations: an issued statement never changes; reissue it'); END;
    `);
  }
};

const STATEMENT_PDF: DonationsMigration = {
  id: '20261025090000',
  description: "the fingerprint of the PDF a statement was emailed as (#51)",
  up: (db) => {
    db.exec(`
      -- The SHA-256 of the PDF attached when the statement was emailed; null when it went as the page alone.
      ALTER TABLE accounting_donations_statements ADD COLUMN pdf_sha256 TEXT;
      DROP TRIGGER accounting_donations_statements_fixed;
      CREATE TRIGGER accounting_donations_statements_fixed BEFORE UPDATE ON accounting_donations_statements
      WHEN NEW.id IS NOT OLD.id OR NEW.donor_type IS NOT OLD.donor_type OR NEW.donor_id IS NOT OLD.donor_id
        OR NEW.donor_name IS NOT OLD.donor_name OR NEW.year IS NOT OLD.year OR NEW.html IS NOT OLD.html
        OR NEW.sha256 IS NOT OLD.sha256 OR NEW.total IS NOT OLD.total OR NEW.deductible IS NOT OLD.deductible
        OR NEW.gift_count IS NOT OLD.gift_count OR NEW.issued_by IS NOT OLD.issued_by OR NEW.issued_at IS NOT OLD.issued_at
        OR (NEW.status IS NOT OLD.status AND NOT (OLD.status = 'issued' AND NEW.status = 'superseded'
              AND NEW.superseded_by IS NOT NULL AND NEW.reissue_reason IS NOT NULL AND NEW.reissue_reason <> ''))
        OR (NEW.superseded_by IS NOT OLD.superseded_by AND NEW.status = OLD.status)
        OR (NEW.emailed_at IS NOT OLD.emailed_at AND OLD.emailed_at IS NOT NULL)
        OR (NEW.pdf_sha256 IS NOT OLD.pdf_sha256 AND OLD.emailed_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'donations: an issued statement never changes; reissue it'); END;
    `);
  }
};

const DONATION_COUNT: DonationsMigration = {
  id: '20261025120000',
  description: 'statements count donations, not gifts (D-042, #64)',
  up: (db) => {
    db.exec(`
      -- One term, donation (D-042). A rename of the column only: issued statements keep their
      -- values, their pages and their fingerprints. SQLite renames it in the guard trigger too.
      ALTER TABLE accounting_donations_statements RENAME COLUMN gift_count TO donation_count;
    `);
  }
};

export const DONATIONS_MIGRATIONS: DonationsMigration[] = [INKIND_AND_PLEDGES, STATEMENTS, STATEMENT_PDF, DONATION_COUNT];
