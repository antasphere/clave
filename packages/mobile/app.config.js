module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    antasphereIssuer: process.env.CLAVE_ANTASPHERE_ISSUER || undefined,
    mobileRelayUrl: process.env.CLAVE_MOBILE_RELAY || undefined
  }
})
