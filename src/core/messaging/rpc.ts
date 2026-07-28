import { defineExtensionMessaging } from '@webext-core/messaging';
import type { ProtocolMap } from './protocol';

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
