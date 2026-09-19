import { createPluginAdapterFactory } from '../../runtime-plugins/providers'
import { RuntimePluginRegistry } from '../../runtime-plugins/registry'

export const createAdapter = createPluginAdapterFactory(new RuntimePluginRegistry())
