import { parentPort } from 'node:worker_threads'
import { handleGuardRequest, type GuardRequest } from './guardRunner'

/** Worker thread entry of the command guard (bundled with `?nodeWorker`). */
parentPort?.on('message', (request: GuardRequest) => {
  parentPort?.postMessage(handleGuardRequest(request))
})
