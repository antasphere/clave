/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, read by Metro */
module.exports = function (api) {
  api.cache(true)
  return { presets: ['babel-preset-expo'] }
}
