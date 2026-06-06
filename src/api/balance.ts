// Importamos los tipos de Next.js para manejar requests y responses
import { NextRequest, NextResponse } from 'next/server';
// Importamos el cliente de Prisma para interactuar con la base de datos
import { prisma } from '@/lib/prisma';

// Función handler para el endpoint GET /api/balance
export async function GET(req: NextRequest) {
  try {
    // Obtenemos los parámetros de búsqueda de la URL
    const { searchParams } = new URL(req.url);
    // Obtenemos el parámetro walletAddress de los query params
    const walletAddress = searchParams.get('walletAddress');

    // Validamos que el walletAddress esté presente
    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Missing walletAddress parameter' },
        { status: 400 }
      );
    }

    // Buscamos el usuario por walletAddress con todas sus relaciones
    const user = await prisma.user.findUnique({
      where: { walletAddress },
      // Incluimos las posiciones activas del usuario
      include: {
        positions: true,
        // Incluimos las órdenes pendientes del usuario
        pendingOrders: true,
        // Incluimos el historial de trades del usuario (ordenado por fecha descendente, máximo 50)
        tradeHistory: {
          orderBy: { createdAt: 'desc' },
          take: 50
        }
      }
    });

    // Si el usuario no existe, retornamos error 404
    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Retornamos respuesta exitosa con los datos del usuario
    return NextResponse.json({
      success: true,
      user: {
        // Dirección de wallet del usuario
        walletAddress: user.walletAddress,
        // Balance disponible del usuario
        availableBalance: user.availableBalance,
        // Posiciones activas del usuario
        positions: user.positions,
        // Órdenes pendientes del usuario
        pendingOrders: user.pendingOrders,
        // Trades recientes del usuario
        recentTrades: user.tradeHistory
      }
    });

  } catch (error) {
    // Logueamos el error para debugging
    console.error('Get balance error:', error);
    // Retornamos error genérico de servidor
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
