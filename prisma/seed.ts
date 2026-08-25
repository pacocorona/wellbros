/**
 * Semilla de Wellbros.
 *
 *   tsx prisma/seed.ts          (o `prisma db seed`, ver prisma.config.ts)
 *
 * Es IDEMPOTENTE: correrlo dos veces no duplica nada y —sobre todo— no
 * reescribe la contraseña del superusuario si ya existe.
 *
 * QUÉ CREA, POR OMISIÓN: la superusuaria y NADA MÁS. Es lo que hace falta en el
 * servidor de producción, donde las propiedades reales las da de alta ella
 * misma desde la aplicación.
 *
 * Variables de entorno (todas opcionales):
 *
 *   SEED_SUPERUSER_EMAIL     correo de la superusuaria (por omisión, el de Ivonne)
 *   SEED_SUPERUSER_NAME      su nombre completo
 *   SEED_SUPERUSER_PASSWORD  su contraseña inicial. VACÍA cuenta como no puesta:
 *                            se genera una aleatoria y se imprime UNA sola vez.
 *   SEED_DEMO_DATA=true      añade además 2 propiedades y 21 semanas por cada
 *                            una, para tener algo que mirar en desarrollo.
 *                            Cualquier otro valor —incluido vacío— no las crea.
 *
 * Sea cual sea la contraseña inicial, la superusuaria nace con
 * `mustChangePassword` encendido: la eligió esta semilla, no ella, y la
 * aplicación la obliga a cambiarla antes de dejarla navegar.
 *
 * No crea reservas de ejemplo ni siquiera con SEED_DEMO_DATA: las reservas son
 * el registro real de quién usa la casa, y una reserva falsa es una discusión
 * familiar esperando a ocurrir.
 */

import "dotenv/config";

import { randomBytes } from "node:crypto";

import { TZDate } from "@date-fns/tz";
import { hash } from "@node-rs/argon2";
import { PrismaPg } from "@prisma/adapter-pg";
import { addDays } from "date-fns";

// Ruta relativa y no "@/generated/prisma": el cliente generado no trae index,
// el módulo real es client.ts, y este script lo carga tsx sin el resolvedor
// de alias de Next.
import { PrismaClient } from "../src/generated/prisma/client";

const ZONA_NEGOCIO = "America/Mexico_City";

// Configurable porque la idempotencia se ancla al correo: si el valor cambiara
// más tarde con la constante quemada, una segunda siembra crearía un SEGUNDO
// superusuario en vez de corregir el primero.
const SUPERUSUARIO_EMAIL =
  process.env.SEED_SUPERUSER_EMAIL?.trim() || "ibuenfil@hotmail.com";
const SUPERUSUARIO_NOMBRE =
  process.env.SEED_SUPERUSER_NAME?.trim() || "Ivonne Buenfil";

/**
 * Datos de ejemplo: dos propiedades y sus semanas.
 *
 * Van detrás de una variable EXPLÍCITA porque en producción son basura que
 * alguien tendría que borrar a mano —y borrar una propiedad con semanas abiertas
 * no es un clic—, mientras que en desarrollo son justo lo que hace falta para
 * ver el calendario con algo dentro. Se exige el literal «true» y no cualquier
 * valor: un `SEED_DEMO_DATA=false` mal entendido no debe sembrar nada.
 */
const SEMBRAR_DEMO = process.env.SEED_DEMO_DATA?.trim().toLowerCase() === "true";

/** Semanas que se abren hacia atrás y hacia adelante del viernes en curso. */
const SEMANAS_ATRAS = 4;
const SEMANAS_ADELANTE = 16;

const PROPIEDADES = ["Casa del Lago", "Departamento Playa"] as const;

/**
 * Parámetros argon2id (recomendación OWASP 2024: 19 MiB, 2 pasadas, 1 hilo).
 * @node-rs/argon2 ya usa Argon2id por defecto; el resto se fija aquí para que
 * el costo no dependa de la versión de la librería.
 */
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * Único canal de salida del script. No es console.log: esto es una herramienta
 * de línea de comandos, su interfaz ES la salida estándar.
 */
function salida(linea = ""): void {
  process.stdout.write(`${linea}\n`);
}

function dosDigitos(n: number): string {
  return String(n).padStart(2, "0");
}

/** `yyyy-MM-dd` de una fecha civil, leída en su propia zona. */
function fechaISO(d: TZDate): string {
  return `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}`;
}

/**
 * Viernes de la semana en curso en la zona de negocio (el mismo día si hoy es
 * viernes, si no el inmediato anterior).
 *
 * Se calcula sobre un TZDate y no sobre `new Date()`: en Cancún o en Madrid el
 * "hoy" del servidor no es el "hoy" de la familia, y una semana que empieza en
 * jueves rompería el CHECK de la base.
 */
function viernesEnCurso(ahora: Date): TZDate {
  const hoy = new TZDate(ahora.getTime(), ZONA_NEGOCIO);
  // getDay(): 0 = domingo … 5 = viernes. Retroceso hasta el viernes anterior.
  const retroceso = (hoy.getDay() - 5 + 7) % 7;
  return addDays(hoy, -retroceso) as TZDate;
}

/** 24 bytes ≈ 192 bits: de sobra para una contraseña de un solo uso. */
function contrasenaAleatoria(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Crea al superusuario si falta. Si ya existe NO le toca la contraseña: un seed
 * que expulsa al dueño de la plataforma es peor que un seed que no hace nada.
 */
async function asegurarSuperusuario(prisma: PrismaClient): Promise<string> {
  const existente = await prisma.user.findUnique({
    where: { email: SUPERUSUARIO_EMAIL },
    select: { id: true },
  });

  if (existente) {
    // Se reafirma el rol por si alguien lo degradó a mano, nada más.
    await prisma.user.update({
      where: { id: existente.id },
      data: { role: "SUPERUSER", isActive: true },
    });
    salida(`· Superusuario ya existía: ${SUPERUSUARIO_EMAIL} (contraseña intacta)`);
    return existente.id;
  }

  // Si ya hay un SUPERUSER con OTRO correo, crear uno nuevo dejaría dos personas
  // con control total sin que nadie lo note. Es más seguro no hacer nada y avisar.
  const otroAdmin = await prisma.user.findFirst({
    where: { role: "SUPERUSER" },
    select: { id: true, email: true },
  });

  if (otroAdmin) {
    salida(
      `· Ya existe un superusuario con otro correo (${otroAdmin.email}). ` +
        `No se crea un segundo: si querías reemplazarlo, cambia su correo a mano ` +
        `o corre la semilla con SEED_SUPERUSER_EMAIL=${otroAdmin.email}.`,
    );
    return otroAdmin.id;
  }

  // `?.trim() || undefined` y no `??`, igual que EMAIL y NAME. Con `??` una
  // cadena VACÍA —que es exactamente lo que trae .env.example— pasaba intacta y
  // la superusuaria quedaba creada con la contraseña vacía: imposible de usar,
  // porque el formulario de acceso exige al menos un carácter, y sin ningún
  // flujo de recuperación con el que salir del atolladero. La única salida era
  // borrar la fila a mano en la base.
  const provista = process.env.SEED_SUPERUSER_PASSWORD?.trim() || undefined;
  const contrasena = provista ?? contrasenaAleatoria();
  const passwordHash = await hash(contrasena, ARGON2);

  const creado = await prisma.user.create({
    data: {
      email: SUPERUSUARIO_EMAIL,
      fullName: SUPERUSUARIO_NOMBRE,
      passwordHash,
      role: "SUPERUSER",
      // Venga de SEED_SUPERUSER_PASSWORD o del generador, esta contraseña la
      // eligió la semilla y no su dueña: hay que cambiarla al primer acceso.
      mustChangePassword: true,
    },
    select: { id: true },
  });

  salida(`· Superusuario creado: ${SUPERUSUARIO_EMAIL}`);
  salida("  La aplicación le exigirá cambiar la contraseña en su primer acceso.");

  if (!provista) {
    // Se imprime UNA sola vez y nunca se guarda en claro: si se pierde, hay que
    // restablecerla desde la aplicación.
    salida();
    salida("  ───────────────────────────────────────────────────────────");
    salida("  Contraseña inicial generada. Se muestra UNA SOLA VEZ:");
    salida();
    salida(`      ${contrasena}`);
    salida("  ───────────────────────────────────────────────────────────");
    salida();
    salida("  Sirve para entrar una vez: la aplicación pedirá cambiarla ahí");
    salida("  mismo. Para fijarla tú, exporta SEED_SUPERUSER_PASSWORD antes");
    salida("  de correr la semilla.");
    salida();
  }

  return creado.id;
}

/**
 * Abre las semanas de una propiedad.
 *
 * Va en SQL crudo, no con prisma.weekSlot.create(), porque end_date y
 * anchor_month son COLUMNAS GENERADAS: Prisma las declara como campos
 * obligatorios (no sabe que son derivadas) y PostgreSQL rechaza cualquier
 * INSERT que las mencione (error 428C9). El ON CONFLICT da la idempotencia.
 */
async function abrirSemanas(
  prisma: PrismaClient,
  propertyId: string,
  creadoPor: string,
  viernes: readonly string[],
): Promise<number> {
  let abiertas = 0;

  for (const inicio of viernes) {
    abiertas += await prisma.$executeRaw`
      INSERT INTO week_slots (property_id, start_date, created_by)
      VALUES (${propertyId}::uuid, ${inicio}::date, ${creadoPor}::uuid)
      ON CONFLICT (property_id, start_date) DO NOTHING
    `;
  }

  return abiertas;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Falta DATABASE_URL. Copia .env.example a .env y levanta la base con `docker compose up -d`.",
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    salida("Sembrando Wellbros…");

    const superusuarioId = await asegurarSuperusuario(prisma);

    if (SEMBRAR_DEMO) {
      const ancla = viernesEnCurso(new Date());
      const viernes: string[] = [];
      for (let i = -SEMANAS_ATRAS; i <= SEMANAS_ADELANTE; i += 1) {
        viernes.push(fechaISO(addDays(ancla, i * 7) as TZDate));
      }

      for (const nombre of PROPIEDADES) {
        const propiedad = await prisma.property.upsert({
          where: { name: nombre },
          update: {},
          create: { name: nombre },
          select: { id: true },
        });

        const nuevas = await abrirSemanas(
          prisma,
          propiedad.id,
          superusuarioId,
          viernes,
        );

        salida(
          `· ${nombre}: ${nuevas} semana(s) nueva(s) de ${viernes.length} (${viernes[0]} → ${viernes[viernes.length - 1]})`,
        );
      }
    } else {
      // Se dice en voz alta: quien esperaba ver el calendario poblado en
      // desarrollo debe enterarse aquí, no buscando el fallo media hora.
      salida("· Sin datos de ejemplo. Para crearlos: SEED_DEMO_DATA=true");
    }

    const [usuarios, propiedades, semanas] = await Promise.all([
      prisma.user.count(),
      prisma.property.count(),
      prisma.weekSlot.count(),
    ]);

    salida();
    salida(
      `Listo: ${usuarios} usuario(s), ${propiedades} propiedad(es), ${semanas} semana(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  process.stderr.write(
    `La semilla falló: ${error instanceof Error ? error.message : String(error)}\n`,
  );
});
