// Relay addressing. Each device has one "home" on the relay (a random secret token, and the ID made from it), and
// all of its mailboxes live there. A mailbox address is "<home ID>.<mailbox ID>": what a code or a message
// carries so others can write to it. The home token proves ownership and never goes into an address.
import { randomId } from '../model/ids';
import { homeIdFor } from './crypto';

export interface Home {
  id: string;
  token: string;
}

const PART = '[A-Za-z0-9_-]{22}';
export const ADDRESS = new RegExp(`^${PART}\\.${PART}$`);

export async function newHome(): Promise<Home> {
  const token = randomId();
  return { id: await homeIdFor(token), token };
}

/** A fresh mailbox address in this device's home. */
export const newAddress = (home: Home): string => `${home.id}.${randomId()}`;

/** The two parts of an address. */
export function splitAddress(address: string): { home: string; box: string } {
  const [home = '', box = ''] = address.split('.');
  return { home, box };
}

/** Is this address in this home (one of ours)? */
export const isInHome = (address: string | undefined, home: Home): address is string => !!address && ADDRESS.test(address) && splitAddress(address).home === home.id;
