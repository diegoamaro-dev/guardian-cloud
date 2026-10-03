/**
 * E1 — aislamiento de INSTALACIÓN, comprobado donde se decide de verdad.
 *
 * `benchEnvIsolation.test.ts` cubre `resolveBuildVariant`, que es la
 * declaración del entorno. Pero el `applicationId` y el nombre visible de
 * un APK NO salen de ahí: salen del proyecto Android versionado, porque
 * `android.package` y `name` del config de Expo sólo llegarían al nativo
 * a través de `expo prebuild`, que no es un paso de build en este
 * repositorio (`docs/RELEASE_CHECKLIST_v0.3.md` §3.1).
 *
 * Así que este fichero afirma el contrato sobre los ficheros que la ruta
 * real sí lee: `android/app/build.gradle`, los dos `strings.xml` y
 * `eas.json`. Es una prueba ESTÁTICA: acredita la configuración, no un
 * APK. Lo que un APK contenga sólo lo acredita un APK.
 *
 * Existe sobre todo por una razón defensiva: si algún día alguien ejecuta
 * `expo prebuild`, el plugin de Expo reescribe `namespace` ADEMÁS de
 * `applicationId` y renombra los paquetes Kotlin en disco. Eso destruiría
 * la divergencia intencional que decide
 * `docs/decisions/ADR-ANDROID-APPLICATION-ID.md`, y en silencio. Este test
 * es lo que lo convertiría en un fallo visible.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string): string =>
  readFileSync(resolve(__dirname, '..', rel), 'utf8');

const APP_GRADLE = read('android/app/build.gradle');
const STRINGS_MAIN = read('android/app/src/main/res/values/strings.xml');
const STRINGS_BENCH = read('android/app/src/bench/res/values/strings.xml');
interface EasProfile {
  android?: { gradleCommand?: string; buildType?: string };
  env?: Record<string, string>;
  environment?: string;
}

const EAS_JSON = JSON.parse(read('eas.json')) as {
  build: Record<string, EasProfile>;
};

/** Un perfil que falta es un fallo del contrato, no un `undefined`. */
function profile(name: string): EasProfile {
  const found = EAS_JSON.build[name];
  if (!found) throw new Error(`eas.json no declara el perfil '${name}'`);
  return found;
}

const PRODUCTION_APPLICATION_ID = 'com.guariacloud.app';
const BENCH_APPLICATION_ID = 'com.guariacloud.app.bench';
const PRODUCTION_NAMESPACE = 'com.guardiancloud.app';

/**
 * Cuerpo de un bloque `nombre { … }` de Gradle, delimitado **contando
 * llaves** en vez de confiando en la indentación: así una reindentación
 * del fichero no rompe estas pruebas, y el bloque que se inspecciona es
 * el real y no una ventana de líneas.
 */
function gradleBlock(source: string, name: string): string {
  const declaration = source.indexOf(`${name} {`);
  if (declaration < 0) {
    throw new Error(`build.gradle no declara el bloque '${name}'`);
  }
  const open = source.indexOf('{', declaration);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) {
      return source.slice(open + 1, i);
    }
  }
  throw new Error(`el bloque '${name}' no se cierra`);
}

const FLAVORS = gradleBlock(APP_GRADLE, 'productFlavors');

/**
 * El gradle sin comentarios de bloque ni de línea completa. La
 * prohibición de `applicationIdSuffix` es sobre el CÓDIGO: el fichero
 * explica a propósito por qué no se usa, y esa explicación no debe hacer
 * fallar la prueba que la justifica.
 */
const APP_GRADLE_CODE = APP_GRADLE.replace(/\/\*[\s\S]*?\*\//g, '').replace(
  /^\s*\/\/.*$/gm,
  '',
);

/** El `applicationId` que declara un flavor, o `null` si no declara ninguno. */
function flavorApplicationId(flavor: string): string | null {
  return (
    gradleBlock(FLAVORS, flavor).match(/applicationId '([^']+)'/)?.[1] ?? null
  );
}

/** `app_name` del source set indicado, que es el nombre que instala Android. */
function appName(stringsXml: string): string | null {
  return (
    stringsXml.match(/<string name="app_name">([^<]*)<\/string>/)?.[1] ?? null
  );
}

describe('E1 · identidad nativa de producción — no se mueve', () => {
  it('conserva EXACTAMENTE su applicationId, declarado en su flavor', () => {
    expect(flavorApplicationId('production')).toBe(PRODUCTION_APPLICATION_ID);
  });

  it('no existe ningún applicationId fuera de los dos flavors', () => {
    const declared = [...APP_GRADLE.matchAll(/applicationId '([^']+)'/g)].map(
      (m) => m[1],
    );
    // Exactamente dos, uno por flavor. Un tercero en cualquier otro bloque
    // sería una identidad alternativa, que es justo lo que no puede
    // existir.
    expect(declared.sort()).toEqual(
      [PRODUCTION_APPLICATION_ID, BENCH_APPLICATION_ID].sort(),
    );
  });

  it('`defaultConfig` NO declara applicationId', () => {
    // Una sola fuente por flavor. Con el valor también aquí, Gradle
    // resolvería bien —el flavor gana— pero una herramienta que leyera
    // `defaultConfig` primero vería el id de producción también para
    // banco, y en silencio.
    expect(gradleBlock(APP_GRADLE, 'defaultConfig')).not.toMatch(
      /applicationId\s/,
    );
  });

  it('conserva el namespace, que NO es el applicationId', () => {
    expect(APP_GRADLE).toContain(`namespace '${PRODUCTION_NAMESPACE}'`);
    // La divergencia es la decisión del ADR. Si estos dos se igualan,
    // alguien ha ejecutado un prebuild o ha "corregido" el ADR sin leerlo.
    expect(PRODUCTION_NAMESPACE).not.toBe(PRODUCTION_APPLICATION_ID);
  });

  it('conserva su nombre visible', () => {
    expect(appName(STRINGS_MAIN)).toBe('Guardian Cloud');
  });

  it('el flavor de producción no lleva recursos propios ni sufijo', () => {
    const production = gradleBlock(FLAVORS, 'production');
    expect(production).toContain("dimension 'env'");
    expect(production).not.toContain('applicationIdSuffix');
  });
});

describe('E1 · identidad nativa de banco — distinta, por configuración', () => {
  it('declara su applicationId completo', () => {
    expect(flavorApplicationId('bench')).toBe(BENCH_APPLICATION_ID);
  });

  it('ningún flavor usa applicationIdSuffix, que EAS CLI no soporta', () => {
    // EAS CLI 24.10.0 rechazó el build con «"applicationIdSuffix" in
    // app/build.gradle is not supported, configure the full application ID
    // under productFlavors», y Expo lo documenta: sólo lee `applicationId`.
    // La comprobación es sobre el fichero entero porque la limitación
    // alcanza también a `buildTypes`.
    expect(APP_GRADLE_CODE).not.toContain('applicationIdSuffix');
  });

  it('declara su propio nombre visible y sólo esa cadena', () => {
    expect(appName(STRINGS_BENCH)).toBe('Guardian Cloud BANCO');
    // El source set de flavor sobrescribe por precedencia; duplicar el
    // resto de `main` sólo crearía dos sitios donde mantener lo mismo.
    expect([...STRINGS_BENCH.matchAll(/<string /g)]).toHaveLength(1);
  });

  it('los dos application id son distintos, así que las instalaciones coexisten', () => {
    // Leídos los dos del fichero, no compuestos aquí: si alguien iguala
    // los flavors, esto falla en vez de seguir afirmando la separación.
    expect(flavorApplicationId('bench')).not.toBe(
      flavorApplicationId('production'),
    );
  });

  it('declara la dimensión de flavor que AGP exige', () => {
    expect(APP_GRADLE).toMatch(/flavorDimensions\s*=\s*\[\s*'env'\s*\]/);
    for (const flavor of ['production', 'bench']) {
      expect(gradleBlock(FLAVORS, flavor)).toContain("dimension 'env'");
    }
  });
});

describe('E1 · el plugin de React Native sigue sabiendo qué es debuggable', () => {
  it('lista las dos variantes debug por su nombre real', () => {
    // Con flavors ya no existe una variante llamada `debug`, que es el
    // único valor por defecto del plugin. Sin esta lista los debug
    // empaquetarían el bundle y el Dev Client no conectaría.
    expect(APP_GRADLE).toMatch(
      /debuggableVariants\s*=\s*\[\s*"productionDebug"\s*,\s*"benchDebug"\s*\]/,
    );
  });
});

/**
 * E1-S · el mapeo perfil → entorno → variante, fijado como contrato.
 *
 * Por qué importa que `environment` esté SIEMPRE escrito: si se omite, EAS
 * **no** se queda sin entorno — elige uno solo: `production` cuando
 * `distribution` es `store`, `development` cuando `developmentClient` es
 * `true`, y `preview` para todo lo demás. El perfil `bench`, que es
 * `internal` y no dev client, caía en el último caso: habría recibido las
 * variables de `preview`, que son las de producción.
 *
 * El plan de esta cuenta no ofrece entornos personalizados, así que la
 * separación se consigue repartiendo los tres estándar en dos mundos:
 *
 *   development + bench  →  entorno `development`  →  BANCO
 *   preview + production →  entornos homónimos     →  real
 *
 * `EXPO_PUBLIC_GC_ENV` se declara aquí y en ningún entorno remoto: una
 * sola fuente, versionada y visible en el diff. La precedencia entre el
 * `env` de un perfil y las variables del entorno no está documentada, y
 * este reparto hace que nunca haga falta conocerla.
 */
describe('E1 · eas.json construye una variante inequívoca por perfil', () => {
  /** El entorno estándar reasignado al mundo BANCO. */
  const BENCH_ENVIRONMENT = 'development';

  const CONTRACT = {
    development: {
      environment: 'development',
      gcEnv: 'bench',
      gradleCommand: ':app:assembleBenchDebug',
    },
    bench: {
      environment: 'development',
      gcEnv: 'bench',
      gradleCommand: ':app:assembleBenchRelease',
    },
    preview: {
      environment: 'preview',
      gcEnv: 'production',
      gradleCommand: ':app:assembleProductionRelease',
    },
    production: {
      environment: 'production',
      gcEnv: 'production',
      gradleCommand: ':app:bundleProductionRelease',
    },
  } as const;

  /** Deriva el flavor del propio comando, que es lo que Gradle ejecuta. */
  const buildsProductionFlavor = (command: string | undefined): boolean =>
    /:(assemble|bundle)Production(Debug|Release)$/.test(command ?? '');

  for (const [name, expected] of Object.entries(CONTRACT)) {
    it(`${name} → entorno ${expected.environment} · ${expected.gcEnv} · ${expected.gradleCommand}`, () => {
      const target = profile(name);
      expect(target.environment).toBe(expected.environment);
      expect(target.env?.EXPO_PUBLIC_GC_ENV).toBe(expected.gcEnv);
      expect(target.android?.gradleCommand).toBe(expected.gradleCommand);
    });
  }

  it('ningún perfil depende de la selección automática de EAS', () => {
    for (const [name, target] of Object.entries(EAS_JSON.build)) {
      expect(target.environment, `perfil ${name} sin environment`).toBeTruthy();
      expect(
        target.env?.EXPO_PUBLIC_GC_ENV,
        `perfil ${name} sin EXPO_PUBLIC_GC_ENV`,
      ).toBeTruthy();
    }
  });

  it('ningún perfil deja la variante sin cualificar', () => {
    for (const [name, target] of Object.entries(EAS_JSON.build)) {
      const command = target.android?.gradleCommand;
      expect(command, `perfil ${name} sin gradleCommand`).toBeTruthy();
      // `assembleRelease` o `bundleRelease` a secas construirían AMBOS
      // flavors, y EAS tendría que elegir entre dos artefactos. Un build
      // de producción no puede depender de ese desempate.
      expect(command).not.toMatch(/:(assemble|bundle)(Release|Debug)$/);
    }
  });

  it('ningún perfil que construya el flavor de producción consume el entorno de banco', () => {
    for (const [name, target] of Object.entries(EAS_JSON.build)) {
      if (!buildsProductionFlavor(target.android?.gradleCommand)) continue;
      expect(
        target.environment,
        `perfil ${name} llevaría datos de banco a una identidad de producción`,
      ).not.toBe(BENCH_ENVIRONMENT);
    }
  });

  it('ningún perfil que consuma el entorno de banco construye el flavor de producción', () => {
    // La recíproca, y no es redundante: cierra el cruce desde el otro
    // lado, de modo que añadir un perfil nuevo por cualquiera de los dos
    // caminos rompa una prueba en vez de pasar inadvertido.
    for (const [name, target] of Object.entries(EAS_JSON.build)) {
      if (target.environment !== BENCH_ENVIRONMENT) continue;
      expect(
        buildsProductionFlavor(target.android?.gradleCommand),
        `perfil ${name} expone el banco a la identidad de producción`,
      ).toBe(false);
    }
  });
});
