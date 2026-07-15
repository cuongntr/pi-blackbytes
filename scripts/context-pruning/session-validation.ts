/** Safe public surface for opaque copied-session validation capabilities. */
export {
  createDisposableSessionCopy,
  createSelectedSessionCatalogHandoff,
  deriveAuthenticatedBranchProjection,
  deriveAuthenticatedCheckpointProjection,
  deriveSelectedSessionCatalogFromPersistedCopy,
  readSelectedSessionCatalogHandoff,
  validateDisposableSessionCopy,
} from "./inventory.js";
export type {
  AuthenticatedBranchProjection,
  AuthenticatedCheckpointProjection,
  DisposableSessionCopy,
  SelectedSessionCatalogHandoff,
  SessionValidation,
} from "./inventory.js";
