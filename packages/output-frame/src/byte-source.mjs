import { createReadBudget } from "./read-budget.mjs";

// One capability per file. A request carries only its byte interval and a
// dedicated reply port. Cancelling that request cannot cancel another read.
// All files of a view share one read budget: a read past it waits its turn,
// and only a read that finds the waiting list full is refused. Without a
// budget, the file gets one of its own.
export function exposeByteSource(source, lifetime, budget = createReadBudget({ lifetime })) {
  const { port1, port2 } = new MessageChannel();
  lifetime.addEventListener("abort", () => port1.close(), { once: true });
  port1.onmessage = ({ data, ports }) => {
    const [reply] = ports;
    if (!reply) return;
    const { offset, length } = data ?? {};
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > source.byteLength - offset
    ) {
      reply.postMessage({ error: "Invalid file read." });
      reply.close();
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime, controller.signal]);
    reply.onmessage = () => controller.abort();
    let started = false;
    // A read cancelled while it waits gets no reply.
    signal.addEventListener("abort", () => started || reply.close(), { once: true });
    const admitted = budget.schedule(signal, async (settle) => {
      started = true;
      try {
        const bytes = await source.read(offset, length, signal);
        signal.throwIfAborted();
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length)
          throw Error("Incomplete file read.");
        // Only transfer the requested span, including for non-dedicated buffers.
        const result = new Uint8Array(bytes);
        reply.postMessage({ bytes: result }, [result.buffer]);
      } catch (error) {
        if (!signal.aborted)
          reply.postMessage({ error: String(error?.message ?? error).slice(0, 240) });
      } finally {
        settle();
        reply.close();
      }
    });
    if (!admitted) {
      if (!signal.aborted) reply.postMessage({ error: "Too many file reads are waiting." });
      reply.close();
    }
  };
  return { byteLength: source.byteLength, port: port2 };
}

export function receiveByteSource({ byteLength, port }, lifetime) {
  lifetime.addEventListener("abort", () => port.close(), { once: true });
  return Object.freeze({
    byteLength,
    async read(offset, length, signal) {
      const cancel = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
      cancel.throwIfAborted();
      const { port1, port2 } = new MessageChannel();
      return new Promise((resolve, reject) => {
        const abort = () => {
          port1.postMessage("cancel");
          port1.close();
          reject(cancel.reason);
        };
        cancel.addEventListener("abort", abort, { once: true });
        port1.onmessage = ({ data }) => {
          cancel.removeEventListener("abort", abort);
          port1.close();
          if (data.error) reject(Error(data.error));
          else resolve(data.bytes);
        };
        port.postMessage({ offset, length }, [port2]);
      });
    },
  });
}
