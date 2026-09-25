import {
  PackageAcquisition,
  validateLockedWheel,
  validateRequirements,
} from "./package-resolver.js";
import { PACKAGE_ACQUISITION_MS } from "./package-limits.js";

export const PACKAGE_RUNTIME_VERSION = "0.28.3";
export const packageName = (requirement) =>
  requirement
    .match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0]
    .toLowerCase()
    .replace(/[-_.]+/g, "-");

export function packageManifest(value) {
  if (value == null)
    return { version: 1, pyodide: PACKAGE_RUNTIME_VERSION, requirements: [], wheels: [] };
  if (
    value.version !== 1 ||
    value.pyodide !== PACKAGE_RUNTIME_VERSION ||
    !Array.isArray(value.wheels) ||
    value.wheels.length > 32
  )
    throw new Error(
      "This notebook's package lock is incompatible with this Python runtime. Clear saved packages, restart Python, then add the packages again.",
    );
  const requirements = validateRequirements(value.requirements);
  const wheels = value.wheels.map(validateLockedWheel);
  if (new Set(wheels.map((wheel) => wheel.name)).size !== wheels.length)
    throw new Error("Duplicate locked package");
  return { version: 1, pyodide: PACKAGE_RUNTIME_VERSION, requirements, wheels };
}

export function removeRequirement(manifest, requirement) {
  const name = packageName(requirement);
  const requirements = manifest.requirements.filter((req) => packageName(req) !== name);
  const retained = new Set(requirements.map(packageName));
  for (let round = 0; round < manifest.wheels.length; round++) {
    for (const wheel of manifest.wheels)
      if (retained.has(wheel.name)) for (const dep of wheel.dependencies) retained.add(dep);
  }
  return {
    ...manifest,
    requirements,
    wheels: manifest.wheels.filter((wheel) => retained.has(wheel.name)),
  };
}

/** Recovery never has to validate or download artifacts that it removes. */
export function removeSavedRequirement(value, requirement) {
  try {
    return removeRequirement(packageManifest(value), requirement);
  } catch {
    const requirements = validateRequirements(value?.requirements);
    const remaining = requirements.filter((req) => packageName(req) !== packageName(requirement));
    if (!remaining.length) return packageManifest(null);
    // Retain user intent and the stale lock marker. A remaining stale lock must
    // still block execution until the owner removes all requirements or clears them.
    return { ...value, requirements: remaining };
  }
}

function inventory(value) {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (spec) =>
        typeof spec !== "string" ||
        !/^[a-z0-9][a-z0-9-]*==[A-Za-z0-9.!+_-]+$/.test(spec) ||
        spec.length > 256,
    )
  )
    throw new Error("Invalid package inventory");
  return value;
}

/** Trusted provider operation, executed under the tenant pool's busy guard. */
export async function installPackageManifest({ runtime, installed, signal }, input, resolver) {
  const sessionSignal = signal;
  signal = AbortSignal.any([signal, AbortSignal.timeout(PACKAGE_ACQUISITION_MS)]);
  const previous = packageManifest(input.manifest);
  let plan;
  if (input.operation === "restore") {
    const acquisition = new PackageAcquisition({ signal });
    const wheels = [];
    for (const wheel of previous.wheels) wheels.push(await acquisition.download(wheel));
    plan = { requirements: previous.requirements, wheels };
  } else if (input.operation === "add") {
    const [requirement] = validateRequirements([input.requirement]);
    const name = packageName(requirement);
    const requirements = [
      ...previous.requirements.filter((req) => packageName(req) !== name),
      requirement,
    ];
    plan = await resolver.resolve(requirements, {
      constraints: previous.wheels
        .filter((wheel) => wheel.name !== name)
        .map((wheel) => `${wheel.name}==${wheel.version}`),
      signal,
    });
  } else throw new Error("Unsupported package operation");
  signal.throwIfAborted();
  const pinned = new Map(previous.wheels.map((wheel) => [wheel.name, wheel]));
  if (
    plan.wheels.some((wheel) => {
      const prior = pinned.get(wheel.name);
      return (
        prior &&
        prior.version === wheel.version &&
        (prior.url !== wheel.url || prior.sha256 !== wheel.sha256 || prior.size !== wheel.size)
      );
    })
  ) {
    return {
      status: "error",
      error:
        "An existing package's download has changed. Saved packages are unchanged; remove that package and restart Python before choosing a new download.",
      needs_restart: false,
    };
  }
  const current = new Map(inventory(installed).map((spec) => spec.split("==")));
  if (
    plan.wheels.some(
      (wheel) => current.has(wheel.name) && current.get(wheel.name) !== wheel.version,
    )
  ) {
    return {
      status: "error",
      error:
        "A different version is already installed. Remove its saved requirement, restart Python, then install the new version.",
      needs_restart: false,
    };
  }
  const wheels = plan.wheels.filter((wheel) => !current.has(wheel.name));
  let result;
  try {
    // Even an empty/malformed saved lock must prove its requirements against
    // the interpreter. An empty wheel list is not evidence of restoration.
    result = await runtime.install({
      wheels,
      requirements: [
        ...plan.requirements,
        ...plan.wheels.map((wheel) => `${wheel.name}==${wheel.version}`),
      ],
    });
    // Acquisition has finished. Installation has its own terminating deadline;
    // a late acquisition timer cannot negate an already confirmed result.
    sessionSignal.throwIfAborted();
    if (result.status !== "ready")
      return {
        status: "error",
        error:
          "Installation failed. Some packages may have changed; saved requirements are unchanged.",
        needs_restart: true,
      };
    inventory(result.installed);
    if (plan.wheels.some((wheel) => !result.installed.includes(`${wheel.name}==${wheel.version}`)))
      throw new Error("Package inventory does not confirm installation");
  } catch {
    return {
      status: "error",
      error: "The install result could not be confirmed. Saved requirements are unchanged.",
      needs_restart: true,
    };
  }
  return {
    status: "ready",
    installed: result.installed,
    manifest: {
      version: 1,
      pyodide: PACKAGE_RUNTIME_VERSION,
      requirements: plan.requirements,
      wheels: plan.wheels.map(({ body: _body, ...wheel }) => validateLockedWheel(wheel)),
    },
  };
}
