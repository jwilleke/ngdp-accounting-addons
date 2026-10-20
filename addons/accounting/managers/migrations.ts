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

const ACCOUNTS: AccountingMigration = {
  id: '20261018120000',
  description: 'every entry names the account its money sits in; account opening balances (D-031)',
  up: (db) => {
    db.exec(`
      -- Where the money sits, beside the fund it is for. Accounts are configuration, so this
      -- is an id, not a foreign key. Entries posted before accounts existed are in Checking.
      ALTER TABLE accounting_transactions ADD COLUMN account_id TEXT NOT NULL DEFAULT 'checking';
      CREATE INDEX accounting_transactions_account ON accounting_transactions (account_id, date);

      -- The money in an entry never changes, now including its account.
      DROP TRIGGER accounting_transactions_money_fixed;
      CREATE TRIGGER accounting_transactions_money_fixed BEFORE UPDATE ON accounting_transactions
      WHEN NEW.id IS NOT OLD.id OR NEW.direction IS NOT OLD.direction OR NEW.amount IS NOT OLD.amount
        OR NEW.currency IS NOT OLD.currency OR NEW.date IS NOT OLD.date OR NEW.fund_id IS NOT OLD.fund_id
        OR NEW.account_id IS NOT OLD.account_id
        OR NEW.category IS NOT OLD.category OR NEW.party_person_id IS NOT OLD.party_person_id
        OR NEW.party_name IS NOT OLD.party_name OR NEW.payment_method IS NOT OLD.payment_method
        OR NEW.payment_method_id IS NOT OLD.payment_method_id OR NEW.provider IS NOT OLD.provider
        OR NEW.confirmation_number IS NOT OLD.confirmation_number OR NEW.source_type IS NOT OLD.source_type
        OR NEW.source_id IS NOT OLD.source_id OR NEW.voids_id IS NOT OLD.voids_id
        OR NEW.transfer_id IS NOT OLD.transfer_id OR NEW.created_by IS NOT OLD.created_by
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'accounting: a posted entry''s money never changes; void it and post a replacement'); END;

      -- What an account held on the day the books started, set once by the treasurer.
      CREATE TABLE accounting_account_openings (
        account_id      TEXT PRIMARY KEY,
        opening_balance INTEGER NOT NULL,
        opening_date    TEXT NOT NULL,
        created_by      TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );

      -- An account's opening balance and date are money; like a fund's, they do not change.
      CREATE TRIGGER accounting_account_openings_fixed BEFORE UPDATE ON accounting_account_openings
      BEGIN SELECT RAISE(ABORT, 'accounting: an account''s opening balance and date do not change'); END;
      CREATE TRIGGER accounting_account_openings_no_delete BEFORE DELETE ON accounting_account_openings
      BEGIN SELECT RAISE(ABORT, 'accounting: an account''s opening balance and date do not change'); END;
    `);
  }
};

const DEPOSITS: AccountingMigration = {
  id: '20261018200000',
  description: 'deposits: receipts taken from Cash on Hand to a bank account (D-031)',
  up: (db) => {
    db.exec(`
      -- A deposit: one line on the bank statement. Its money moves in paired ledger entries
      -- (source_type 'deposit', source_id the deposit's id); this row and its receipts say why.
      CREATE TABLE accounting_deposits (
        id             TEXT PRIMARY KEY,
        number         TEXT NOT NULL UNIQUE,
        date           TEXT NOT NULL,
        account_id     TEXT NOT NULL,
        slip_reference TEXT,
        total          INTEGER NOT NULL CHECK (total > 0),
        memo           TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL CHECK (status IN ('posted', 'voided')),
        void_reason    TEXT,
        created_by     TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        CHECK (status <> 'voided' OR (void_reason IS NOT NULL AND void_reason <> ''))
      );

      -- The receipts in a deposit. A receipt is in at most one deposit that is not undone.
      CREATE TABLE accounting_deposit_receipts (
        deposit_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        amount     INTEGER NOT NULL CHECK (amount > 0),
        undone     INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1)),
        PRIMARY KEY (deposit_id, receipt_id)
      );
      CREATE UNIQUE INDEX accounting_deposit_receipts_once ON accounting_deposit_receipts (receipt_id) WHERE undone = 0;

      CREATE TRIGGER accounting_deposits_no_delete BEFORE DELETE ON accounting_deposits
      BEGIN SELECT RAISE(ABORT, 'accounting: deposits are undone, never deleted'); END;

      -- A deposit's money never changes; it only goes from posted to voided (undone), once, with a reason.
      CREATE TRIGGER accounting_deposits_fixed BEFORE UPDATE ON accounting_deposits
      WHEN NEW.id IS NOT OLD.id OR NEW.number IS NOT OLD.number OR NEW.date IS NOT OLD.date
        OR NEW.account_id IS NOT OLD.account_id OR NEW.slip_reference IS NOT OLD.slip_reference
        OR NEW.total IS NOT OLD.total OR NEW.memo IS NOT OLD.memo
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
        OR NOT (OLD.status = 'posted' AND NEW.status = 'voided' AND NEW.void_reason IS NOT NULL AND NEW.void_reason <> '')
      BEGIN SELECT RAISE(ABORT, 'accounting: a deposit never changes; undo it, once, with a reason'); END;

      CREATE TRIGGER accounting_deposit_receipts_no_delete BEFORE DELETE ON accounting_deposit_receipts
      BEGIN SELECT RAISE(ABORT, 'accounting: a deposit keeps its receipts'); END;
      CREATE TRIGGER accounting_deposit_receipts_fixed BEFORE UPDATE ON accounting_deposit_receipts
      WHEN NEW.deposit_id IS NOT OLD.deposit_id OR NEW.receipt_id IS NOT OLD.receipt_id
        OR NEW.amount IS NOT OLD.amount OR NOT (OLD.undone = 0 AND NEW.undone = 1)
      BEGIN SELECT RAISE(ABORT, 'accounting: a deposit keeps its receipts'); END;
    `);
  }
};

const DOCUMENTS: AccountingMigration = {
  id: '20261019120000',
  description: 'receipts and refunds are documents with lines; refunds numbered RF- (D-033)',
  up: (db) => {
    db.exec(`
      -- A receipt or a refund: one record, one number, shown once; its lines are ledger entries
      -- (document_id), each with its own amount, fund and category. Balances still add up entries.
      CREATE TABLE accounting_documents (
        id                TEXT PRIMARY KEY,
        kind              TEXT NOT NULL CHECK (kind IN ('receipt', 'refund')),
        number            TEXT,
        provider          TEXT,
        date              TEXT NOT NULL,
        party_person_id   TEXT,
        party_name        TEXT,
        payment_method    TEXT,
        payment_method_id TEXT,
        account_id        TEXT NOT NULL,
        total             INTEGER NOT NULL CHECK (total > 0),
        memo              TEXT NOT NULL DEFAULT '',
        source_type       TEXT,
        source_id         TEXT,
        status            TEXT NOT NULL CHECK (status IN ('posted', 'voided')),
        void_reason       TEXT,
        created_by        TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        CHECK (status <> 'voided' OR (void_reason IS NOT NULL AND void_reason <> ''))
      );
      CREATE UNIQUE INDEX accounting_documents_number ON accounting_documents (kind, provider, number) WHERE number IS NOT NULL;

      ALTER TABLE accounting_transactions ADD COLUMN document_id TEXT;
      -- A refund line: the receipt line it gives back.
      ALTER TABLE accounting_transactions ADD COLUMN line_of TEXT;
      CREATE INDEX accounting_transactions_document ON accounting_transactions (document_id);

      -- Existing receipts become one-line receipts, keeping their ids and numbers. The number moves
      -- to the document; the entry is the receipt's one line.
      DROP TRIGGER accounting_transactions_money_fixed;
      INSERT INTO accounting_documents (id, kind, number, provider, date, party_person_id, party_name, payment_method,
          payment_method_id, account_id, total, memo, source_type, source_id, status, void_reason, created_by, created_at)
        SELECT id, 'receipt', confirmation_number, provider, date, party_person_id, party_name, payment_method,
          payment_method_id, account_id, amount, memo, CASE WHEN source_type = 'receipt' THEN NULL ELSE source_type END,
          CASE WHEN source_type = 'receipt' THEN NULL ELSE source_id END, status, void_reason, created_by, created_at
        FROM accounting_transactions WHERE direction = 'in' AND confirmation_number IS NOT NULL;
      UPDATE accounting_transactions SET document_id = id, confirmation_number = NULL, provider = NULL
        WHERE direction = 'in' AND confirmation_number IS NOT NULL;

      -- Existing refunds become one-line refunds, numbered RF-0001 onwards in the order they were made.
      INSERT INTO accounting_documents (id, kind, number, provider, date, party_person_id, party_name, payment_method,
          payment_method_id, account_id, total, memo, source_type, source_id, status, void_reason, created_by, created_at)
        SELECT id, 'refund', 'RF-' || printf('%04d', ROW_NUMBER() OVER (ORDER BY created_at, id)), 'manual', date,
          party_person_id, party_name, payment_method, payment_method_id, account_id, amount, memo, 'receipt', source_id,
          status, void_reason, created_by, created_at
        FROM accounting_transactions WHERE source_type = 'receipt-refund';
      UPDATE accounting_transactions SET document_id = id, line_of = source_id WHERE source_type = 'receipt-refund';

      -- The money in an entry never changes, now including the document it belongs to.
      CREATE TRIGGER accounting_transactions_money_fixed BEFORE UPDATE ON accounting_transactions
      WHEN NEW.id IS NOT OLD.id OR NEW.direction IS NOT OLD.direction OR NEW.amount IS NOT OLD.amount
        OR NEW.currency IS NOT OLD.currency OR NEW.date IS NOT OLD.date OR NEW.fund_id IS NOT OLD.fund_id
        OR NEW.account_id IS NOT OLD.account_id OR NEW.document_id IS NOT OLD.document_id OR NEW.line_of IS NOT OLD.line_of
        OR NEW.category IS NOT OLD.category OR NEW.party_person_id IS NOT OLD.party_person_id
        OR NEW.party_name IS NOT OLD.party_name OR NEW.payment_method IS NOT OLD.payment_method
        OR NEW.payment_method_id IS NOT OLD.payment_method_id OR NEW.provider IS NOT OLD.provider
        OR NEW.confirmation_number IS NOT OLD.confirmation_number OR NEW.source_type IS NOT OLD.source_type
        OR NEW.source_id IS NOT OLD.source_id OR NEW.voids_id IS NOT OLD.voids_id
        OR NEW.transfer_id IS NOT OLD.transfer_id OR NEW.created_by IS NOT OLD.created_by
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'accounting: a posted entry''s money never changes; void it and post a replacement'); END;

      CREATE TRIGGER accounting_documents_no_delete BEFORE DELETE ON accounting_documents
      BEGIN SELECT RAISE(ABORT, 'accounting: receipts and refunds are voided, never deleted'); END;
      CREATE TRIGGER accounting_documents_fixed BEFORE UPDATE ON accounting_documents
      WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.number IS NOT OLD.number OR NEW.provider IS NOT OLD.provider
        OR NEW.date IS NOT OLD.date OR NEW.party_person_id IS NOT OLD.party_person_id OR NEW.party_name IS NOT OLD.party_name
        OR NEW.payment_method IS NOT OLD.payment_method OR NEW.payment_method_id IS NOT OLD.payment_method_id
        OR NEW.account_id IS NOT OLD.account_id OR NEW.total IS NOT OLD.total OR NEW.memo IS NOT OLD.memo
        OR NEW.source_type IS NOT OLD.source_type OR NEW.source_id IS NOT OLD.source_id
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
        OR NOT (OLD.status = 'posted' AND NEW.status = 'voided' AND NEW.void_reason IS NOT NULL AND NEW.void_reason <> '')
      BEGIN SELECT RAISE(ABORT, 'accounting: a receipt or refund never changes; void it, once, with a reason'); END;
    `);
  }
};

const CLEARINGS: AccountingMigration = {
  id: '20261019180000',
  description: 'deposits marked cleared with the date the bank shows (D-032)',
  up: (db) => {
    db.exec(`
      -- The bank credited a deposit on this date. Clearing moves no money; it is a mark for matching
      -- the statement. A wrong mark is taken off once, with a reason, and stays as history.
      CREATE TABLE accounting_deposit_clearings (
        id             TEXT PRIMARY KEY,
        deposit_id     TEXT NOT NULL,
        cleared_date   TEXT NOT NULL,
        removed        INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
        removed_reason TEXT,
        created_by     TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        CHECK (removed = 0 OR (removed_reason IS NOT NULL AND removed_reason <> ''))
      );
      CREATE UNIQUE INDEX accounting_deposit_clearings_once ON accounting_deposit_clearings (deposit_id) WHERE removed = 0;

      CREATE TRIGGER accounting_deposit_clearings_no_delete BEFORE DELETE ON accounting_deposit_clearings
      BEGIN SELECT RAISE(ABORT, 'accounting: a cleared mark is taken off, never deleted'); END;
      CREATE TRIGGER accounting_deposit_clearings_fixed BEFORE UPDATE ON accounting_deposit_clearings
      WHEN NEW.id IS NOT OLD.id OR NEW.deposit_id IS NOT OLD.deposit_id OR NEW.cleared_date IS NOT OLD.cleared_date
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
        OR NOT (OLD.removed = 0 AND NEW.removed = 1 AND NEW.removed_reason IS NOT NULL AND NEW.removed_reason <> '')
      BEGIN SELECT RAISE(ABORT, 'accounting: a cleared mark never changes; take it off, once, with a reason'); END;
    `);
  }
};

const BOUNCES: AccountingMigration = {
  id: '20261019200000',
  description: 'bounced checks: the returned check, the bank fee and what the payer owes (D-032)',
  up: (db) => {
    db.exec(`
      -- A deposited check the bank returned. The receipt never changes; the returned-check and fee
      -- entries (source_type 'returned-check' and 'bounce-fee', source_id this id) take the money
      -- back out. What the payer owes is check + fee + penalty; repayments are receipts that
      -- reference this record.
      CREATE TABLE accounting_bounces (
        id           TEXT PRIMARY KEY,
        receipt_id   TEXT NOT NULL UNIQUE,
        deposit_id   TEXT NOT NULL,
        date         TEXT NOT NULL,
        account_id   TEXT NOT NULL,
        check_amount INTEGER NOT NULL CHECK (check_amount > 0),
        fee          INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
        penalty      INTEGER NOT NULL DEFAULT 0 CHECK (penalty >= 0),
        memo         TEXT NOT NULL DEFAULT '',
        created_by   TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );

      CREATE TRIGGER accounting_bounces_no_delete BEFORE DELETE ON accounting_bounces
      BEGIN SELECT RAISE(ABORT, 'accounting: a bounced check is never deleted'); END;
      CREATE TRIGGER accounting_bounces_fixed BEFORE UPDATE ON accounting_bounces
      BEGIN SELECT RAISE(ABORT, 'accounting: a bounced check never changes'); END;
    `);
  }
};

const LINE_DETAILS: AccountingMigration = {
  id: '20261020120000',
  description: 'details a module adds to a receipt line, e.g. a gift (D-036)',
  up: (db) => {
    db.exec(`
      -- What a module adds to a receipt line, by kind (\`gift\` from accounting-donations), as JSON the
      -- module validates. Written in the same transaction as the line; never changed or deleted.
      CREATE TABLE accounting_line_details (
        line_id TEXT NOT NULL,
        kind    TEXT NOT NULL,
        data    TEXT NOT NULL,
        PRIMARY KEY (line_id, kind)
      );
      CREATE TRIGGER accounting_line_details_fixed BEFORE UPDATE ON accounting_line_details
      BEGIN SELECT RAISE(ABORT, 'accounting: a line''s details never change; void the receipt and record it again'); END;
      CREATE TRIGGER accounting_line_details_no_delete BEFORE DELETE ON accounting_line_details
      BEGIN SELECT RAISE(ABORT, 'accounting: a line''s details are never deleted'); END;
    `);
  }
};

const PERIOD_LOCKS: AccountingMigration = {
  id: '20261020160000',
  description: 'period locks: how periods are locked, chosen by the treasurer, and the locks (#19)',
  up: (db) => {
    db.exec(`
      -- How this site's periods are locked, as the treasurer last set it (month, quarter, half-year or
      -- year, and the month the fiscal year starts). Append-only: the newest row stands.
      CREATE TABLE accounting_lock_settings (
        seq                INTEGER PRIMARY KEY AUTOINCREMENT,
        period             TEXT NOT NULL CHECK (period IN ('month', 'quarter', 'half-year', 'year')),
        fiscal_start_month INTEGER NOT NULL CHECK (fiscal_start_month BETWEEN 1 AND 12),
        created_by         TEXT NOT NULL,
        created_at         TEXT NOT NULL
      );
      CREATE TRIGGER accounting_lock_settings_fixed BEFORE UPDATE ON accounting_lock_settings
      BEGIN SELECT RAISE(ABORT, 'accounting: lock settings are append-only'); END;
      CREATE TRIGGER accounting_lock_settings_no_delete BEFORE DELETE ON accounting_lock_settings
      BEGIN SELECT RAISE(ABORT, 'accounting: lock settings are append-only'); END;

      -- Everything dated on or before through_date is locked while the lock stands. A lock is taken
      -- off once, with a reason, and stays as history.
      CREATE TABLE accounting_period_locks (
        id            TEXT PRIMARY KEY,
        through_date  TEXT NOT NULL,
        period        TEXT NOT NULL,
        removed       INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
        removed_reason TEXT,
        created_by    TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        CHECK (removed = 0 OR (removed_reason IS NOT NULL AND removed_reason <> ''))
      );
      CREATE TRIGGER accounting_period_locks_fixed BEFORE UPDATE ON accounting_period_locks
      WHEN NEW.id IS NOT OLD.id OR NEW.through_date IS NOT OLD.through_date OR NEW.period IS NOT OLD.period
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
        OR NOT (OLD.removed = 0 AND NEW.removed = 1 AND NEW.removed_reason IS NOT NULL AND NEW.removed_reason <> '')
      BEGIN SELECT RAISE(ABORT, 'accounting: a period lock never changes; take it off, once, with a reason'); END;
      CREATE TRIGGER accounting_period_locks_no_delete BEFORE DELETE ON accounting_period_locks
      BEGIN SELECT RAISE(ABORT, 'accounting: a period lock is taken off, never deleted'); END;
    `);
  }
};

export const ACCOUNTING_MIGRATIONS: AccountingMigration[] = [FUNDS_TRANSACTIONS_HISTORY, ACCOUNTS, DEPOSITS, DOCUMENTS, CLEARINGS, BOUNCES, LINE_DETAILS, PERIOD_LOCKS];
