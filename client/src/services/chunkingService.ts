export type Chunk = {
  id: string;
  index: number;
  buffer: ArrayBuffer;
};

export class ChunkingService {
  private defaultChunkSize = 1024 * 1024; // 1MB

  async splitFile(file: File, chunkSize?: number): Promise<Chunk[]> {
    const size = chunkSize || this.defaultChunkSize;
    const buffer = await file.arrayBuffer();
    const chunks: Chunk[] = [];

    let offset = 0;
    let index = 0;

    while (offset < buffer.byteLength) {
      const slice = buffer.slice(offset, offset + size);
      chunks.push({
        id: crypto.randomUUID(),
        index,
        buffer: slice,
      });

      offset += size;
      index++;
    }

    return chunks;
  }
}

export const chunkingService = new ChunkingService();
