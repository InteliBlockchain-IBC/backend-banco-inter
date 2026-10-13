-- Origem de cada deployment registrado.
--
-- 'seed': contrato sintético da massa de demonstração; os comandos /api/mock
-- podem gravar ofertas, eventos e cursor simulados nele.
-- 'listener': contrato real da Sepolia, alimentado só pelo listener. Simular
-- nele colidiria com ids on-chain, avançaria o cursor e debitaria limites que
-- a chain não debitou.
--
-- Os registros existentes vêm do seed; o listener marca o seu na próxima
-- passagem.

ALTER TABLE contract_deployments
    ADD COLUMN source text NOT NULL DEFAULT 'seed'
        CHECK (source IN ('seed', 'listener'));
