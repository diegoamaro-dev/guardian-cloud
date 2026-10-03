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
const PRODUCTION_NAMESPACE = 'com.guardiancloud.app';

/** `app_name` del source set indicado, que es el nombre que instala Android. */
function appName(stringsXml: string): string | null {
  return (
    stringsXml.match(/<string name="app_name">([^<]*)<\/string>/)?.[1] ?? null
  );
}

describe('E1 · identidad nativa de producción — no se mueve', () => {
  it('conserva EXACTAMENTE su applicationId', () => {
    const matches = [...APP_GRADLE.matchAll(/applicationId '([^']+)'/g)].map(
      (m) => m[1],
    );
    // Uno y sólo uno: un segundo `applicationId` en otro bloque sería una
    // identidad de producción alternativa, que es justo lo que no puede
    // existir.
    expect(matches).toEqual([PRODUCTION_APPLICATION_ID]);
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

  it('no le añade sufijo ni recursos propios al flavor de producción', () => {
    const productionBlock = APP_GRADLE.match(
      /production \{([\s\S]*?)\n {8}\}/,
    )?.[1];
    expect(productionBlock).toBeTruthy();
    expect(productionBlock).toContain("dimension 'env'");
    expect(productionBlock).not.toContain('applicationIdSuffix');
  });
});

describe('E1 · identidad nativa de banco — distinta, por configuración', () => {
  it('deriva su applicationId del sufijo del flavor', () => {
    const benchBlock = APP_GRADLE.match(/bench \{([\s\S]*?)\n {8}\}/)?.[1];
    expect(benchBlock).toBeTruthy();
    expect(benchBlock).toContain("applicationIdSuffix '.bench'");

    const suffix = benchBlock?.match(/applicationIdSuffix '([^']+)'/)?.[1];
    // Esto es lo que Android compondrá. Se escribe aquí para que el valor
    // esperado sea legible sin saber cómo funciona AGP.
    expect(`${PRODUCTION_APPLICATION_ID}${suffix}`).toBe(
      'com.guariacloud.app.bench',
    );
  });

  it('declara su propio nombre visible y sólo esa cadena', () => {
    expect(appName(STRINGS_BENCH)).toBe('Guardian Cloud BANCO');
    // El source set de flavor sobrescribe por precedencia; duplicar el
    // resto de `main` sólo crearía dos sitios donde mantener lo mismo.
    expect([...STRINGS_BENCH.matchAll(/<string /g)]).toHaveLength(1);
  });

  it('los dos application id son distintos, así que las instalaciones coexisten', () => {
    const suffix = APP_GRADLE.match(/applicationIdSuffix '([^']+)'/)?.[1];
    expect(`${PRODUCTION_APPLICATION_ID}${suffix}`).not.toBe(
      PRODUCTION_APPLICATION_ID,
    );
  });

  it('declara la dimensión de flavor que AGP exige', () => {
    expect(APP_GRADLE).toMatch(/flavorDimensions = \['env'\]/);
  });
});

describe('E1 · el plugin de React Native sigue sabiendo qué es debuggable', () => {
  it('lista las dos variantes debug por su nombre real', () => {
    // Con flavors ya no existe una variante llamada `debug`, que es el
    // único valor por defecto del plugin. Sin esta lista los debug
    // empaquetarían el bundle y el Dev Client no conectaría.
    expect(APP_GRADLE).toContain(
      'debuggableVariants = ["productionDebug", "benchDebug"]',
    );
  });
});

describe('E1 · eas.json construye una variante inequívoca por perfil', () => {
  it('el perfil de banco construye BENCH y declara el entorno', () => {
    const bench = profile('bench');
    expect(bench.android?.gradleCommand).toBe(':app:assembleBenchRelease');
    expect(bench.env?.EXPO_PUBLIC_GC_ENV).toBe('bench');
  });

  it('los perfiles de producción construyen el flavor de producción', () => {
    expect(profile('development').android?.gradleCommand).toBe(
      ':app:assembleProductionDebug',
    );
    expect(profile('preview').android?.gradleCommand).toBe(
      ':app:assembleProductionRelease',
    );
    expect(profile('production').android?.gradleCommand).toBe(
      ':app:bundleProductionRelease',
    );
  });

  it('ningún perfil deja la variante sin cualificar', () => {
    for (const [name, profile] of Object.entries(EAS_JSON.build)) {
      const command = profile.android?.gradleCommand;
      expect(command, `perfil ${name} sin gradleCommand`).toBeTruthy();
      // `assembleRelease` o `bundleRelease` a secas construirían AMBOS
      // flavors, y EAS tendría que elegir entre dos artefactos. Un build
      // de producción no puede depender de ese desempate.
      expect(command).not.toMatch(/:(assemble|bundle)(Release|Debug)$/);
    }
  });

  it('el perfil de banco no hereda el entorno de producción', () => {
    // Sin `environment`, EAS no inyecta las variables de ningún entorno
    // remoto. Es deliberado: la relación entorno declarado ↔ proyecto
    // Supabase alcanzado todavía NO tiene guarda, y hasta que la tenga un
    // build de banco no debe poder recibir las credenciales de producción
    // por omisión.
    expect(profile('bench')).not.toHaveProperty('environment');
  });
});
