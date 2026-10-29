/**
 * Who is calling, as the bus carries it. The token check (`../auth.ts`)
 * sets the actor on the correlation context for the rest of the request;
 * the bus copies it into every dispatch and every handler receives it, so
 * a phone-only handler knows which phone asked without a second lookup.
 */
export const OWNER_ACTOR = 'owner'
const DEVICE_PREFIX = 'device:'

export const deviceActor = (deviceId: string): string => `${DEVICE_PREFIX}${deviceId}`

/** The device id of a device actor; null for the owner or for no actor. */
export const deviceIdOfActor = (actor: string | undefined): string | null =>
  actor !== undefined && actor.startsWith(DEVICE_PREFIX) && actor.length > DEVICE_PREFIX.length
    ? actor.slice(DEVICE_PREFIX.length)
    : null
