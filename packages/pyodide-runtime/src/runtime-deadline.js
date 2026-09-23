/** Reject only after host termination settles, including invalidation races. */
export async function runWithDeadline(run, { timeoutMs, terminate, message }) {
  let timer;
  let deadlineError;
  let termination;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      deadlineError = new Error(message);
      termination = Promise.resolve().then(terminate);
      termination.then(() => reject(deadlineError), reject);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(run), timeout]);
  } catch (error) {
    if (deadlineError) {
      await termination;
      throw deadlineError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
