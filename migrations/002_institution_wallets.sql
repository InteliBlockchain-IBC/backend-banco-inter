-- Uma instituicao pode operar varias carteiras.
--
-- A 001 guardava institution_id em contract_wallet_state com
-- UNIQUE (chain_id, contract_address, institution_id): uma carteira por banco
-- em cada contrato, e o vinculo era refeito a cada novo deploy.
--
-- O vinculo carteira -> instituicao e um cadastro off-chain e nao depende do
-- deployment (um endereco EVM e o mesmo em qualquer rede). Ele passa para
-- institution_wallets; contract_wallet_state fica so com o estado on-chain
-- (cadastro e limite), por contrato. Uma carteira vista on-chain sem vinculo
-- continua valida: o listener nao pode descartar eventos de enderecos que o
-- banco ainda nao cadastrou.

CREATE TABLE institution_wallets (
    wallet_address text PRIMARY KEY CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    institution_id uuid NOT NULL REFERENCES institutions(id),
    label text CHECK (label IS NULL OR btrim(label) <> ''),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX institution_wallets_by_institution
    ON institution_wallets (institution_id);

-- Preserva os vinculos existentes. Se a mesma carteira apontava para bancos
-- diferentes em deployments distintos, vale o estado observado mais recente.
INSERT INTO institution_wallets (wallet_address, institution_id)
SELECT DISTINCT ON (wallet_address) wallet_address, institution_id
  FROM contract_wallet_state
 WHERE institution_id IS NOT NULL
 ORDER BY wallet_address, observed_at DESC;

-- Remove a coluna e, com ela, a restricao de uma carteira por banco.
ALTER TABLE contract_wallet_state DROP COLUMN institution_id;
