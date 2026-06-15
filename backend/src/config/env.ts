import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5001),
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid postgres URL' }),
  JWT_SECRET: z.string().min(
    process.env.NODE_ENV === 'production' ? 32 : 8,
    { message: 'JWT_SECRET must be at least 32 characters in production' }
  ),
  TCP_PORT: z.coerce.number().default(5027),
  FUEL_PRICE_NGN_LITER: z.coerce.number().default(1500),
  ALLOWED_ORIGINS: z.string().default(''),
  ENABLE_FLEET_SIMULATOR: z.enum(['true', 'false']).default('false'),
  SEED_DEMO_FLEET: z.enum(['true', 'false']).default('false'),
  REAL_DEVICE_IMEI: z.string().optional(),
  REAL_DEVICE_PLATE: z.string().optional(),
  REAL_DEVICE_CCID: z.string().optional(),
  GOOGLE_CLOUD_VISION_API_KEY: z.string().optional(),
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:\n');
  for (const [field, issues] of Object.entries(parsed.error.flatten().fieldErrors)) {
    console.error(`  ${field}: ${(issues as string[]).join(', ')}`);
  }
  process.exit(1);
}

export default parsed.data;
