// Importamos los tipos de Next.js para manejar requests
import { NextRequest, NextResponse } from 'next/server';

// Obtenemos el API_SECRET_KEY de las variables de entorno
const API_SECRET_KEY = process.env.API_SECRET_KEY || '';

// Función para validar el API_SECRET_KEY en los headers de la petición
export function validateApiSecret(req: NextRequest): NextResponse | null {
  // Obtenemos el header x-api-secret-key de la petición
  const secretKey = req.headers.get('x-api-secret-key');
  // Si el header no está presente o no coincide con el API_SECRET_KEY, retornamos error 401
  if (!secretKey || secretKey !== API_SECRET_KEY) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }
  // Si la validación es exitosa, retornamos null (sin error)
  return null;
}
