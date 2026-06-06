// Importamos el cliente de Prisma
import { PrismaClient } from '@prisma/client';

// Creamos una instancia única del cliente de Prisma para evitar múltiples conexiones
const prisma = new PrismaClient();

// Exportamos la instancia de Prisma para usarla en toda la aplicación
export { prisma };
