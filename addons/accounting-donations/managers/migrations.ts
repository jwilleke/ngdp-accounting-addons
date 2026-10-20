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

export const DONATIONS_MIGRATIONS: DonationsMigration[] = [INKIND_AND_PLEDGES];
