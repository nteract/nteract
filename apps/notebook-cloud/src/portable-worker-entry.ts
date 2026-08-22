import worker, { OwnerComputeIndex, WorkstationEvents } from "./index.ts";
import { NotebookRoom } from "./notebook-room.ts";
import type {
  DurableObjectState,
  Env,
  ExecutionContext,
  ExportedHandler,
} from "./cloudflare-types.ts";
import {
  createS3NotebookObjectStoreFromEnv,
  type S3NotebookObjectStoreEnv,
} from "./s3-notebook-object-store.ts";

interface PortableWorkerEnv extends Env, S3NotebookObjectStoreEnv {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
}

const objectStores = new WeakMap<object, NonNullable<Env["NOTEBOOK_OBJECT_STORE"]>>();

function withPortableObjectStore(env: PortableWorkerEnv): Env {
  if (env.NOTEBOOK_OBJECT_STORE || env.NOTEBOOK_SNAPSHOTS) {
    return env;
  }
  let objectStore = objectStores.get(env);
  if (!objectStore) {
    const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "The portable Worker S3 adapter requires short-lived AWS_ACCESS_KEY_ID and " +
          "AWS_SECRET_ACCESS_KEY values. Non-Worker hosts should use the standard AWS " +
          "credential chain instead.",
      );
    }
    objectStore = createS3NotebookObjectStoreFromEnv(env, {
      credentials: {
        accessKeyId,
        secretAccessKey,
        sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined,
      },
    });
    objectStores.set(env, objectStore);
  }
  return { ...env, NOTEBOOK_OBJECT_STORE: objectStore };
}

const portableWorker: ExportedHandler<PortableWorkerEnv> = {
  async fetch(request: Request, env: PortableWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return worker.fetch(request, withPortableObjectStore(env), ctx);
  },
};

export default portableWorker;

export class PortableNotebookRoom extends NotebookRoom {
  constructor(state: DurableObjectState, env: PortableWorkerEnv) {
    super(state, withPortableObjectStore(env));
  }
}

export { OwnerComputeIndex, WorkstationEvents };
