// Copyright 2013 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { Agent as HTTPSAgent } from 'https';
import type { AgentOptions, RequestOptions } from 'https';
import type { LookupAddress } from 'dns';
import net from 'net';
import tls from 'tls';
import { callbackify, promisify } from 'util';
import { shuffle } from 'lodash';
import pTimeout from 'p-timeout';

import * as log from '../logging/log';
import { electronLookup as electronLookupWithCb } from './dns';
import { strictAssert } from './assert';
import { parseIntOrThrow } from './parseIntOrThrow';
import { sleep } from './sleep';
import { SECOND } from './durations';
import { dropNull } from './dropNull';

// See https://www.rfc-editor.org/rfc/rfc8305#section-8
const DELAY_MS = 250;

// Warning threshold
const CONNECT_THRESHOLD_MS = SECOND;

const CONNECT_TIMEOUT_MS = 10 * SECOND;

const electronLookup = promisify(electronLookupWithCb);

export class Agent extends HTTPSAgent {
  constructor(options: AgentOptions = {}) {
    super({
      ...options,
      lookup: electronLookup,
    });
  }

  public createConnection = callbackify(
    async (options: RequestOptions): Promise<net.Socket> => {
      const { host = options.hostname, port: portString } = options;
      strictAssert(host, 'Agent.createConnection: Missing options.host');
      strictAssert(portString, 'Agent.createConnection: Missing options.port');

      const port = parseIntOrThrow(
        portString,
        'Agent.createConnection: options.port is not an integer'
      );

      const addresses = await electronLookup(host, { all: true });
      const firstAddr = addresses.find(
        ({ family }) => family === 4 || family === 6
      );
      if (!firstAddr) {
        throw new Error(`Agent.createConnection: failed to resolve ${host}`);
      }

      const v4 = shuffle(addresses.filter(({ family }) => family === 4));
      const v6 = shuffle(addresses.filter(({ family }) => family === 6));

      // Interleave addresses for Happy Eyeballs, but keep the first address
      // type from the DNS response first in the list.
      const interleaved = new Array<LookupAddress>();
      while (v4.length !== 0 || v6.length !== 0) {
        const v4Entry = v4.pop();
        const v6Entry = v6.pop();

        if (firstAddr.family === 4) {
          if (v4Entry !== undefined) {
            interleaved.push(v4Entry);
          }
          if (v6Entry !== undefined) {
            interleaved.push(v6Entry);
          }
        } else {
          if (v6Entry !== undefined) {
            interleaved.push(v6Entry);
          }
          if (v4Entry !== undefined) {
            interleaved.push(v4Entry);
          }
        }
      }

      const start = Date.now();

      const { socket, address, v4Attempts, v6Attempts } = await happyEyeballs(
        interleaved,
        port
      );

      const duration = Date.now() - start;
      const logLine =
        `createHTTPSAgent.createConnection(${host}): connected to ` +
        `IPv${address.family} addr after ${duration}ms ` +
        `(v4_attempts=${v4Attempts} v6_attempts=${v6Attempts})`;

      if (v4Attempts + v6Attempts > 1 || duration > CONNECT_THRESHOLD_MS) {
        log.warn(logLine);
      } else {
        log.info(logLine);
      }

      return tls.connect({
        socket,
        ca: options.ca,
        host: dropNull(options.host),
        servername: options.servername,
      });
    }
  );
}

export type HappyEyeballsResult = Readonly<{
  socket: net.Socket;
  address: LookupAddress;
  v4Attempts: number;
  v6Attempts: number;
}>;

export async function happyEyeballs(
  addrs: ReadonlyArray<LookupAddress>,
  port = 443
): Promise<HappyEyeballsResult> {
  const abortControllers = addrs.map(() => new AbortController());

  let v4Attempts = 0;
  let v6Attempts = 0;

  const results = await Promise.allSettled(
    addrs.map(async (addr, index) => {
      const abortController = abortControllers[index];
      if (index !== 0) {
        await sleep(index * DELAY_MS, abortController.signal);
      }

      if (addr.family === 4) {
        v4Attempts += 1;
      } else {
        v6Attempts += 1;
      }

      const socket = await connect({
        address: addr.address,
        port,
        abortSignal: abortController.signal,
      });

      // Abort other connection attempts
      for (const otherController of abortControllers) {
        if (otherController !== abortController) {
          otherController.abort();
        }
      }
      return { socket, abortController, index };
    })
  );

  const fulfilled = results.find(({ status }) => status === 'fulfilled');
  if (fulfilled) {
    strictAssert(
      fulfilled.status === 'fulfilled',
      'Fulfilled promise was not fulfilled'
    );
    const { socket, index } = fulfilled.value;

    return {
      socket,
      address: addrs[index],
      v4Attempts,
      v6Attempts,
    };
  }

  strictAssert(
    results[0].status === 'rejected',
    'No fulfilled promises, but no rejected either'
  );

  // Abort all connection attempts for consistency
  for (const controller of abortControllers) {
    controller.abort();
  }
  throw results[0].reason;
}

type DelayedConnectOptionsType = Readonly<{
  port: number;
  address: string;
  abortSignal?: AbortSignal;
  timeout?: number;
}>;

async function connect({
  port,
  address,
  abortSignal,
  timeout = CONNECT_TIMEOUT_MS,
}: DelayedConnectOptionsType): Promise<net.Socket> {
  const socket = new net.Socket({
    signal: abortSignal,
  });

  return pTimeout(
    new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('error', err => reject(err));

      socket.connect(port, address);
    }),
    timeout,
    'createHTTPSAgent.connect: connection timed out'
  );
}

export function createHTTPSAgent(options: AgentOptions = {}): Agent {
  return new Agent(options);
}
