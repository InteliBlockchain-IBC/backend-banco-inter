-- Projecao inicial do CreditInterbankOffer (Sepolia). PostgreSQL 13+.
-- Inteiros uint256 sao preservados em numeric(78,0); valores BRLt em centavos.
BEGIN;

CREATE TABLE institutions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (btrim(name) <> ''),
    cnpj text UNIQUE CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$'),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contract_deployments (
    chain_id bigint NOT NULL CHECK (chain_id > 0),
    contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
    brl_token_address text NOT NULL CHECK (brl_token_address ~ '^0x[0-9a-f]{40}$'),
    position_token_address text NOT NULL CHECK (position_token_address ~ '^0x[0-9a-f]{40}$'),
    start_block bigint NOT NULL CHECK (start_block >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract_address)
);

CREATE TABLE contract_wallet_state (
    chain_id bigint NOT NULL,
    contract_address text NOT NULL,
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    institution_id uuid REFERENCES institutions(id),
    is_registered boolean NOT NULL DEFAULT false,
    available_limit_cents numeric(78, 0) NOT NULL DEFAULT 0
        CHECK (available_limit_cents >= 0),
    observed_block bigint CHECK (observed_block IS NULL OR observed_block >= 0),
    observed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract_address, wallet_address),
    UNIQUE (chain_id, contract_address, institution_id),
    FOREIGN KEY (chain_id, contract_address)
        REFERENCES contract_deployments (chain_id, contract_address)
);
CREATE INDEX contract_wallet_candidates
    ON contract_wallet_state (chain_id, contract_address, available_limit_cents)
    WHERE is_registered;

CREATE TABLE offers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_id bigint NOT NULL,
    contract_address text NOT NULL,
    onchain_offer_id numeric(78, 0) NOT NULL CHECK (onchain_offer_id > 0),
    lender_wallet text NOT NULL CHECK (lender_wallet ~ '^0x[0-9a-f]{40}$'),
    borrower_wallet text NOT NULL CHECK (borrower_wallet ~ '^0x[0-9a-f]{40}$'),
    amount_cents numeric(78, 0) NOT NULL CHECK (amount_cents > 0),
    rate_cdi_bps numeric(78, 0) NOT NULL CHECK (rate_cdi_bps > 0),
    term_days numeric(78, 0) NOT NULL CHECK (term_days > 0),
    status smallint NOT NULL CHECK (status IN (0, 2, 3, 4, 5)),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
    create_tx_hash text NOT NULL CHECK (create_tx_hash ~ '^0x[0-9a-f]{64}$'),
    created_block bigint NOT NULL CHECK (created_block >= 0),
    indexed_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (chain_id, contract_address)
        REFERENCES contract_deployments (chain_id, contract_address),
    UNIQUE (chain_id, contract_address, onchain_offer_id),
    UNIQUE (id, chain_id, contract_address),
    UNIQUE (id, chain_id, contract_address, onchain_offer_id),
    CHECK (lender_wallet <> borrower_wallet)
);
CREATE INDEX offers_by_status_created ON offers (status, created_at DESC);
CREATE INDEX offers_open_by_expiry ON offers (expires_at) WHERE status = 0;
CREATE INDEX offers_by_lender ON offers (chain_id, lender_wallet, created_at DESC);
CREATE INDEX offers_by_borrower ON offers (chain_id, borrower_wallet, created_at DESC);

CREATE TABLE transaction_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_id bigint NOT NULL,
    contract_address text NOT NULL,
    action text NOT NULL CHECK (action IN
        ('create_offer', 'accept_offer', 'reject_offer', 'cancel_offer')),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'expired')),
    requester_wallet text NOT NULL,
    offer_id uuid,
    borrower_wallet text CHECK (borrower_wallet IS NULL OR borrower_wallet ~ '^0x[0-9a-f]{40}$'),
    amount_cents numeric(78, 0) CHECK (amount_cents IS NULL OR amount_cents > 0),
    rate_cdi_bps numeric(78, 0) CHECK (rate_cdi_bps IS NULL OR rate_cdi_bps > 0),
    term_days numeric(78, 0) CHECK (term_days IS NULL OR term_days > 0),
    validity_seconds numeric(78, 0) CHECK (validity_seconds IS NULL OR validity_seconds > 0),
    tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
    submitted_at timestamptz,
    failure_code text,
    CHECK (status NOT IN ('submitted', 'confirmed') OR tx_hash IS NOT NULL),
    CHECK (
        (action = 'create_offer' AND borrower_wallet IS NOT NULL
            AND borrower_wallet <> requester_wallet AND amount_cents IS NOT NULL
            AND rate_cdi_bps IS NOT NULL AND term_days IS NOT NULL
            AND validity_seconds IS NOT NULL)
        OR (action <> 'create_offer' AND offer_id IS NOT NULL
            AND borrower_wallet IS NULL AND amount_cents IS NULL
            AND rate_cdi_bps IS NULL AND term_days IS NULL AND validity_seconds IS NULL)
    ),
    FOREIGN KEY (chain_id, contract_address)
        REFERENCES contract_deployments (chain_id, contract_address),
    FOREIGN KEY (chain_id, contract_address, requester_wallet)
        REFERENCES contract_wallet_state (chain_id, contract_address, wallet_address),
    FOREIGN KEY (offer_id, chain_id, contract_address)
        REFERENCES offers (id, chain_id, contract_address)
);
CREATE UNIQUE INDEX transaction_requests_by_tx
    ON transaction_requests (chain_id, tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX transaction_requests_pending
    ON transaction_requests (expires_at) WHERE status IN ('pending', 'submitted');

CREATE TABLE chain_events (
    chain_id bigint NOT NULL,
    contract_address text NOT NULL,
    tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    log_index bigint NOT NULL CHECK (log_index >= 0),
    offer_id uuid,
    event_name text NOT NULL CHECK (event_name IN (
        'InstitutionRegistered', 'InstitutionRevoked', 'CreditLimitUpdated',
        'OfferCreated', 'OfferAccepted', 'OfferSettled', 'OfferRejected',
        'OfferCancelled', 'OfferExpired'
    )),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    block_timestamp timestamptz NOT NULL,
    event_args jsonb NOT NULL CHECK (jsonb_typeof(event_args) = 'object'),
    indexed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract_address, tx_hash, log_index),
    FOREIGN KEY (chain_id, contract_address)
        REFERENCES contract_deployments (chain_id, contract_address),
    FOREIGN KEY (offer_id, chain_id, contract_address)
        REFERENCES offers (id, chain_id, contract_address)
);
CREATE INDEX chain_events_by_block
    ON chain_events (chain_id, contract_address, block_number, log_index);
CREATE INDEX chain_events_by_offer
    ON chain_events (offer_id, block_number, log_index);

CREATE TABLE credit_limit_history (
    chain_id bigint NOT NULL,
    contract_address text NOT NULL,
    tx_hash text NOT NULL,
    log_index bigint NOT NULL,
    wallet_address text NOT NULL,
    change_kind text NOT NULL CHECK (change_kind IN ('admin_update', 'settlement')),
    previous_limit_cents numeric(78, 0) NOT NULL CHECK (previous_limit_cents >= 0),
    new_limit_cents numeric(78, 0) NOT NULL CHECK (new_limit_cents >= 0),
    offer_id uuid,
    block_timestamp timestamptz NOT NULL,
    PRIMARY KEY (chain_id, contract_address, tx_hash, log_index),
    FOREIGN KEY (chain_id, contract_address, tx_hash, log_index)
        REFERENCES chain_events (chain_id, contract_address, tx_hash, log_index),
    FOREIGN KEY (chain_id, contract_address, wallet_address)
        REFERENCES contract_wallet_state (chain_id, contract_address, wallet_address),
    FOREIGN KEY (offer_id, chain_id, contract_address)
        REFERENCES offers (id, chain_id, contract_address),
    CHECK ((change_kind = 'settlement' AND offer_id IS NOT NULL)
        OR (change_kind = 'admin_update' AND offer_id IS NULL))
);
CREATE INDEX credit_limit_history_by_wallet
    ON credit_limit_history (chain_id, contract_address, wallet_address, block_timestamp DESC);

CREATE TABLE settlements (
    offer_id uuid PRIMARY KEY,
    chain_id bigint NOT NULL,
    contract_address text NOT NULL,
    onchain_offer_id numeric(78, 0) NOT NULL,
    position_token_id numeric(78, 0) NOT NULL CHECK (position_token_id > 0),
    tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    settled_at timestamptz NOT NULL,
    FOREIGN KEY (offer_id, chain_id, contract_address, onchain_offer_id)
        REFERENCES offers (id, chain_id, contract_address, onchain_offer_id),
    UNIQUE (chain_id, tx_hash),
    UNIQUE (chain_id, contract_address, position_token_id),
    CHECK (position_token_id = onchain_offer_id)
);
CREATE INDEX settlements_by_date ON settlements (settled_at DESC);

CREATE TABLE sync_cursors (
    chain_id bigint NOT NULL,
    contract_address text NOT NULL,
    last_processed_block bigint NOT NULL CHECK (last_processed_block >= 0),
    last_processed_block_hash text
        CHECK (last_processed_block_hash IS NULL
            OR last_processed_block_hash ~ '^0x[0-9a-f]{64}$'),
    last_synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract_address),
    FOREIGN KEY (chain_id, contract_address)
        REFERENCES contract_deployments (chain_id, contract_address)
);

COMMIT;
