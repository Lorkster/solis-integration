import net from 'node:net';

export class ModbusError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'ModbusError';
  }
}

export interface ModbusTarget {
  host: string;
  port?: number;
  unit?: number;
  timeoutMs?: number;
}

/** What the transport needs from a Modbus connection; tests replace it with an in-memory inverter. */
export interface ModbusSession {
  readInput(start: number, count: number): Promise<number[]>;
  readHolding(start: number, count: number): Promise<number[]>;
  writeSingle(register: number, value: number): Promise<void>;
  writeMultiple(start: number, values: number[]): Promise<void>;
}

export interface ModbusConnector {
  /** Runs `work` on one connection. Calls are queued: never two connections at once. */
  session<T>(work: (s: ModbusSession) => Promise<T>): Promise<T>;
}

/**
 * Minimal Modbus TCP client (functions 03, 04, 06, 16) on node:net. Opens one connection per batch
 * of requests and closes it afterwards, which suits a data logger that accepts few connections.
 */
export class ModbusTcpClient implements ModbusConnector {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly target: ModbusTarget) {}

  session<T>(work: (s: ModbusSession) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.runSession(work));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runSession<T>(work: (s: ModbusSession) => Promise<T>): Promise<T> {
    const socket = await this.connect();
    const conn = new Connection(socket, this.target.unit ?? 1, this.target.timeoutMs ?? 8_000);
    try {
      return await work(conn);
    } finally {
      socket.destroy();
    }
  }

  private connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.target.host, port: this.target.port ?? 502 });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ModbusError(`No answer from ${this.target.host}:${this.target.port ?? 502}`));
      }, this.target.timeoutMs ?? 8_000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new ModbusError(`${err.message} (${this.target.host})`));
      });
    });
  }
}

/** One open connection: requests are sent one at a time and matched by transaction id. */
class Connection implements ModbusSession {
  private tid = 0;
  private buffer = Buffer.alloc(0);
  private waiting: { tid: number; resolve: (pdu: Buffer) => void; reject: (err: Error) => void } | null = null;

  constructor(private readonly socket: net.Socket, private readonly unit: number, private readonly timeoutMs: number) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.fail(new ModbusError(err.message)));
    socket.on('close', () => this.fail(new ModbusError('Connection closed by the logger')));
  }

  async readInput(start: number, count: number): Promise<number[]> {
    return registers(await this.request(Buffer.from([0x04, start >> 8, start & 0xff, count >> 8, count & 0xff])), count);
  }

  async readHolding(start: number, count: number): Promise<number[]> {
    return registers(await this.request(Buffer.from([0x03, start >> 8, start & 0xff, count >> 8, count & 0xff])), count);
  }

  async writeSingle(register: number, value: number): Promise<void> {
    await this.request(Buffer.from([0x06, register >> 8, register & 0xff, (value >> 8) & 0xff, value & 0xff]));
  }

  async writeMultiple(start: number, values: number[]): Promise<void> {
    const pdu = Buffer.alloc(6 + values.length * 2);
    pdu.writeUInt8(0x10, 0);
    pdu.writeUInt16BE(start, 1);
    pdu.writeUInt16BE(values.length, 3);
    pdu.writeUInt8(values.length * 2, 5);
    values.forEach((v, i) => pdu.writeUInt16BE(v & 0xffff, 6 + i * 2));
    await this.request(pdu);
  }

  private request(pdu: Buffer): Promise<Buffer> {
    this.tid = (this.tid + 1) & 0xffff;
    const header = Buffer.alloc(7);
    header.writeUInt16BE(this.tid, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(pdu.length + 1, 4);
    header.writeUInt8(this.unit, 6);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ModbusError(`Timeout (function ${pdu[0]})`)), this.timeoutMs);
      this.waiting = {
        tid: this.tid,
        resolve: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.socket.write(Buffer.concat([header, pdu]));
    }).then((answer) => {
      if (answer[0] & 0x80) throw new ModbusError(`Modbus exception ${answer[1]} for function ${pdu[0] & 0x7f}`, answer[1]);
      return answer;
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 7) {
      const length = this.buffer.readUInt16BE(4);
      if (this.buffer.length < 6 + length) return;
      const tid = this.buffer.readUInt16BE(0);
      const pdu = this.buffer.subarray(7, 6 + length);
      this.buffer = this.buffer.subarray(6 + length);
      if (this.waiting && this.waiting.tid === tid) {
        const w = this.waiting;
        this.waiting = null;
        w.resolve(Buffer.from(pdu));
      }
    }
  }

  private fail(err: Error): void {
    const w = this.waiting;
    this.waiting = null;
    w?.reject(err);
  }
}

function registers(pdu: Buffer, count: number): number[] {
  const bytes = pdu[1];
  if (bytes !== count * 2) throw new ModbusError(`Expected ${count} registers, got ${bytes / 2}`);
  return Array.from({ length: count }, (_, i) => pdu.readUInt16BE(2 + i * 2));
}
