/**
 * The accounting database's migration ledger (docs/plans/ledger-design.md).
 *
 * Run by ngdpbase's DatabaseManager through `openAddonDatabase('accounting', …)`
 * and recorded in `accounting_schema_migrations`. Each entry is a frozen
 * snapshot of what it did on its date: it never imports live code, and it is
 * never edited after it has shipped — a change is a new, later entry.
 *
 * Every table starts with `accounting_`, so one backup can later hold several
 * databases and split them back by table name.
 */

/** The slice of the SQLite handle a migration uses. */
export interface MigrationDb {
  exec(sql: string): unknown;
}

export interface AccountingMigration {
  /** YYYYMMDDHHMMSS, strictly ascending. */
  id: string;
  description: string;
  up: (db: MigrationDb) => void;
}

/** The record table for this add-on's ledger. */
export const ACCOUNTING_LEDGER_TABLE = 'accounting_schema_migrations';

const FUNDS_TRANSACTIONS_HISTORY: AccountingMigration = {
  id: '20261008120000',
  description: 'funds, transactions and history, with the rules that keep money from changing quietly',
  up: (db) => {
    db.exec(`
      CREATE TABLE accounting_funds (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        description     TEXT NOT NULL DEFAULT '',
        restricted      INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),
        active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        opening_balance INTEGER NOT NULL DEFAULT 0,
        opening_date    TEXT NOT NULL,
        created_by      TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );

      CREATE TABLE accounting_transactions (
        id                  TEXT PRIMARY KEY,
        direction           TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        amount              INTEGER NOT NULL CHECK (amount > 0),
        currency            TEXT NOT NULL CHECK (length(currency) = 3),
        date                TEXT NOT NULL,
        fund_id             TEXT NOT NULL,
        category            TEXT NOT NULL,
        party_person_id     TEXT,
        party_name          TEXT,
        payment_method      TEXT,
        payment_method_id   TEXT,
        provider            TEXT,
        confirmation_number TEXT,
        source_type         TEXT NOT NULL,
        source_id           TEXT,
        status              TEXT NOT NULL CHECK (status IN ('posted', 'voided')),
        voids_id            TEXT,
        voided_by_id        TEXT,
        void_reason         TEXT,
        transfer_id         TEXT,
        memo                TEXT NOT NULL DEFAULT '',
        created_by          TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        CHECK (status <> 'voided' OR (void_reason IS NOT NULL AND void_reason <> ''))
      );

      CREATE INDEX accounting_transactions_fund ON accounting_transactions (fund_id, date);
      CREATE INDEX accounting_transactions_transfer ON accounting_transactions (transfer_id);
      CREATE UNIQUE INDEX accounting_transactions_provider_payment
        ON accounting_transactions (provider, confirmation_number)
        WHERE provider IS NOT NULL AND confirmation_number IS NOT NULL;

      CREATE TABLE accounting_history (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        at        TEXT NOT NULL,
        actor     TEXT NOT NULL,
        action    TEXT NOT NULL,
        entity    TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        before    TEXT,
        after     TEXT,
        reason    TEXT
      );

      -- Funds are closed, never deleted.
      CREATE TRIGGER accounting_funds_no_delete BEFORE DELETE ON accounting_funds
      BEGIN SELECT RAISE(ABORT, 'accounting: funds are closed, never deleted'); END;

      -- A fund's opening balance and date are money; they do not change after creation.
      CREATE TRIGGER accounting_funds_opening_fixed BEFORE UPDATE ON accounting_funds
      WHEN NEW.id IS NOT OLD.id OR NEW.opening_balance IS NOT OLD.opening_balance
        OR NEW.opening_date IS NOT OLD.opening_date OR NEW.created_by IS NOT OLD.created_by
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'accounting: a fund''s opening balance and date do not change'); END;

      -- Every entry belongs to a fund that exists (foreign keys are not switched on per connection).
      CREATE TRIGGER accounting_transactions_fund_exists BEFORE INSERT ON accounting_transactions
      WHEN (SELECT id FROM accounting_funds WHERE id = NEW.fund_id) IS NULL
      BEGIN SELECT RAISE(ABORT, 'accounting: unknown fund'); END;

      -- Ledger entries are never deleted.
      CREATE TRIGGER accounting_transactions_no_delete BEFORE DELETE ON accounting_transactions
      BEGIN SELECT RAISE(ABORT, 'accounting: ledger entries are never deleted; void instead'); END;

      -- The money in an entry never changes: amount, direction, fund, date, party, payment, links.
      CREATE TRIGGER accounting_transactions_money_fixed BEFORE UPDATE ON accounting_transactions
      WHEN NEW.id IS NOT OLD.id OR NEW.direction IS NOT OLD.direction OR NEW.amount IS NOT OLD.amount
        OR NEW.currency IS NOT OLD.currency OR NEW.date IS NOT OLD.date OR NEW.fund_id IS NOT OLD.fund_id
        OR NEW.category IS NOT OLD.category OR NEW.party_person_id IS NOT OLD.party_person_id
        OR NEW.party_name IS NOT OLD.party_name OR NEW.payment_method IS NOT OLD.payment_method
        OR NEW.payment_method_id IS NOT OLD.payment_method_id OR NEW.provider IS NOT OLD.provider
        OR NEW.confirmation_number IS NOT OLD.confirmation_number OR NEW.source_type IS NOT OLD.source_type
        OR NEW.source_id IS NOT OLD.source_id OR NEW.voids_id IS NOT OLD.voids_id
        OR NEW.transfer_id IS NOT OLD.transfer_id OR NEW.created_by IS NOT OLD.created_by
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'accounting: a posted entry''s money never changes; void it and post a replacement'); END;

      -- Status only goes from posted to voided, once, with a reason.
      CREATE TRIGGER accounting_transactions_void_once BEFORE UPDATE ON accounting_transactions
      WHEN (NEW.status IS NOT OLD.status OR NEW.voided_by_id IS NOT OLD.voided_by_id OR NEW.void_reason IS NOT OLD.void_reason)
        AND NOT (OLD.status = 'posted' AND NEW.status = 'voided'
                 AND NEW.void_reason IS NOT NULL AND NEW.void_reason <> '')
      BEGIN SELECT RAISE(ABORT, 'accounting: an entry can only go from posted to voided, once, with a reason'); END;

      -- History is append-only.
      CREATE TRIGGER accounting_history_no_update BEFORE UPDATE ON accounting_history
      BEGIN SELECT RAISE(ABORT, 'accounting: history is append-only'); END;
      CREATE TRIGGER accounting_history_no_delete BEFORE DELETE ON accounting_history
      BEGIN SELECT RAISE(ABORT, 'accounting: history is append-only'); END;
    `);
  }
};

export const ACCOUNTING_MIGRATIONS: AccountingMigration[] = [FUNDS_TRANSACTIONS_HISTORY];
