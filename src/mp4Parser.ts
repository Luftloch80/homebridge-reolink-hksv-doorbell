import type { Readable } from 'node:stream';

export interface Mp4Box {
  /** Four character box type, e.g. "ftyp", "moov", "moof", "mdat". */
  type: string;
  /** Raw bytes of the box, including its 8 (or 16 for 64-bit sizes) byte header. */
  raw: Buffer;
}

/**
 * Reads consecutive ISO-BMFF boxes (`size` + `fourcc` + `payload`) from a raw byte stream,
 * such as the fragmented mp4 ffmpeg writes to stdout with `-movflags frag_keyframe+empty_moov`.
 */
export class Mp4BoxReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private leftover: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(readable: Readable) {
    this.iterator = readable[Symbol.asyncIterator]();
  }

  private async readLength(length: number): Promise<Buffer | undefined> {
    if (length === 0) {
      return Buffer.alloc(0);
    }
    while (this.leftover.length < length) {
      if (this.ended) {
        return undefined;
      }
      const { value, done } = await this.iterator.next();
      if (done) {
        this.ended = true;
        return undefined;
      }
      this.leftover = this.leftover.length === 0 ? value : Buffer.concat([this.leftover, value]);
    }
    const result = this.leftover.subarray(0, length);
    this.leftover = this.leftover.subarray(length);
    return result;
  }

  async *boxes(): AsyncGenerator<Mp4Box> {
    for (;;) {
      const header = await this.readLength(8);
      if (!header) {
        return;
      }

      let size = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      let headerBytes = header;

      if (size === 1) {
        // 64-bit extended size, stored in the 8 bytes immediately following the standard header.
        const extendedSize = await this.readLength(8);
        if (!extendedSize) {
          return;
        }
        headerBytes = Buffer.concat([header, extendedSize]);
        size = Number(extendedSize.readBigUInt64BE(0));
      }

      const payloadLength = size - headerBytes.length;
      const payload = payloadLength > 0 ? await this.readLength(payloadLength) : Buffer.alloc(0);
      if (payload === undefined) {
        return;
      }

      yield { type, raw: Buffer.concat([headerBytes, payload]) };
    }
  }
}
