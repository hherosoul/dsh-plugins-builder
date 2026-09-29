// {{PKG_BASE}} seam — Definition: owns the service name and the
// Request/Result contract (the single source of truth for this capability).
// TS projects export interface Request / Result here.

export const serviceName = '{{ROW_ID}}'

/** @typedef {{ text: string }} Request */
/** @typedef {{ echoed: string }} Result */
