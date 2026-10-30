module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    antasphereIssuer: process.env.CLAVE_ANTASPHERE_ISSUER || undefined,
    mobileRelayUrl: process.env.CLAVE_MOBILE_RELAY || undefined,
    ...(process.env.CLAVE_MOBILE_PROOF_URL
      ? {
          mobileProofUrl: process.env.CLAVE_MOBILE_PROOF_URL,
          mobileCandidate: process.env.CLAVE_MOBILE_CANDIDATE,
          mobileWorktree: __dirname
        }
      : {})
  }
})
