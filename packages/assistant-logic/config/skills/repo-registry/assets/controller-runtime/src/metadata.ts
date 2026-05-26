import type { AppMetadataMap, OpsMetadata } from "./schema.js";

type LegacyDeploymentMetadata = {
  alias: string;
  sourceHost?: string | null;
  sourcePath?: string | null;
  deployHost?: string | null;
  deployPath?: string | null;
  domain?: string | null;
};

function cloneMetadata<T>(value: T): T {
  return structuredClone(value);
}

export function mergeMetadata<T extends Record<string, unknown>>(primary?: T | null, fallback?: T | null): T | undefined {
  if (!primary && !fallback) return undefined;
  return {
    ...(fallback ? cloneMetadata(fallback) : {}),
    ...(primary ? cloneMetadata(primary) : {})
  } as T;
}

export function mergeAppsMetadata(primary?: AppMetadataMap | null, fallback?: AppMetadataMap | null): AppMetadataMap | undefined {
  if (!primary && !fallback) return undefined;
  const next: AppMetadataMap = fallback ? cloneMetadata(fallback) : {};

  for (const [appName, primaryApp] of Object.entries(primary ?? {})) {
    const fallbackApp = next[appName];
    if (!fallbackApp) {
      next[appName] = cloneMetadata(primaryApp);
      continue;
    }

    const environments = fallbackApp.environments ? cloneMetadata(fallbackApp.environments) : {};
    for (const [envName, primaryEnv] of Object.entries(primaryApp.environments ?? {})) {
      const fallbackEnv = environments[envName];
      environments[envName] = {
        ...(fallbackEnv ?? {}),
        ...cloneMetadata(primaryEnv),
        source: mergeMetadata(primaryEnv.source, fallbackEnv?.source),
        deploy: mergeMetadata(primaryEnv.deploy, fallbackEnv?.deploy),
        dependencies: mergeMetadata(primaryEnv.dependencies, fallbackEnv?.dependencies),
        health_checks: primaryEnv.health_checks ?? fallbackEnv?.health_checks,
        backups: primaryEnv.backups ?? fallbackEnv?.backups,
        assumptions: primaryEnv.assumptions ?? fallbackEnv?.assumptions
      };
    }

    next[appName] = {
      ...fallbackApp,
      ...cloneMetadata(primaryApp),
      environments
    };
  }

  return next;
}

export function hasMetadata(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0);
}

function firstProductionDeploy(apps: AppMetadataMap | undefined, alias: string) {
  const preferred = apps?.[alias];
  const app = preferred ?? (apps ? Object.values(apps)[0] : undefined);
  const environments = app?.environments;
  if (!environments) return undefined;
  const environment = environments.production ?? Object.values(environments)[0];
  return environment?.deploy;
}

export function legacyDeploymentFromApps(apps: AppMetadataMap | undefined, alias: string): {
  deployHost?: string;
  deployPath?: string;
  domain?: string;
} {
  const deploy = firstProductionDeploy(apps, alias);
  return {
    deployHost: deploy?.host,
    deployPath: deploy?.path,
    domain: deploy?.domain
  };
}

export function backfillAppsMetadata(
  apps: AppMetadataMap | undefined,
  metadata: LegacyDeploymentMetadata
): AppMetadataMap | undefined {
  const hasSource = Boolean(metadata.sourceHost || metadata.sourcePath);
  const hasDeploy = Boolean(metadata.deployHost || metadata.deployPath || metadata.domain);
  if (!apps && !hasDeploy) return undefined;

  const next: AppMetadataMap = apps ? cloneMetadata(apps) : {};
  if (!hasSource && !hasDeploy) return next;

  const app = next[metadata.alias] ? { ...next[metadata.alias] } : {};
  const environments = app.environments ? { ...app.environments } : {};
  const production = environments.production ? { ...environments.production } : {};

  if (hasSource) {
    const source = production.source ? { ...production.source } : {};
    if (metadata.sourceHost && !source.host) source.host = metadata.sourceHost;
    if (metadata.sourcePath && !source.path) source.path = metadata.sourcePath;
    production.source = source;
  }

  if (hasDeploy) {
    const deploy = production.deploy ? { ...production.deploy } : {};
    if (metadata.deployHost && !deploy.host) deploy.host = metadata.deployHost;
    if (metadata.deployPath && !deploy.path) deploy.path = metadata.deployPath;
    if (metadata.domain && !deploy.domain) deploy.domain = metadata.domain;
    production.deploy = deploy;
  }

  environments.production = production;
  app.environments = environments;
  next[metadata.alias] = app;
  return next;
}

export function metadataOrUndefined<T extends Record<string, unknown>>(metadata: T | undefined): T | undefined {
  return hasMetadata(metadata) ? metadata : undefined;
}

export type { OpsMetadata };
