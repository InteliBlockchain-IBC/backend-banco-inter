import { parseAbi } from "viem";

/** ABI pública mínima, mantida junto ao indexador. */
export const creditInterbankOfferAbi = parseAbi([
  "event InstitutionRegistered(address indexed wallet, uint256 timestamp)",
  "event InstitutionRevoked(address indexed wallet, uint256 timestamp)",
  "event CreditLimitUpdated(address indexed institution, uint256 previousLimit, uint256 newLimit, uint256 timestamp)",
  "event OfferCreated(uint256 indexed offerId, address indexed lender, address indexed borrower, uint256 amount, uint256 rateCDI, uint256 term, uint256 expiresAt)",
  "event OfferAccepted(uint256 indexed offerId, address indexed borrower, uint256 timestamp)",
  "event OfferSettled(uint256 indexed offerId, address indexed lender, address indexed borrower, uint256 amount, uint256 rateCDI, uint256 term, uint256 positionTokenId, uint256 timestamp)",
  "event OfferRejected(uint256 indexed offerId, address indexed borrower, uint256 timestamp)",
  "event OfferCancelled(uint256 indexed offerId, uint256 timestamp)",
  "event OfferExpired(uint256 indexed offerId, uint256 timestamp)",
]);
