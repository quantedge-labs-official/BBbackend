// Importamos los tipos de Next.js para manejar requests y responses
import { NextRequest, NextResponse } from 'next/server';
// Importamos el cliente de Prisma para interactuar con la base de datos
import { prisma } from '@/lib/prisma';
// Importamos el middleware para validar el API_SECRET_KEY
import { validateApiSecret } from '@/lib/middleware';

// Función handler para el endpoint POST /api/order/liquidate (PROTEGIDO)
export async function POST(req: NextRequest) {
  // Validamos el API_SECRET_KEY en los headers (protección contra llamadas no autorizadas)
  const authError = validateApiSecret(req);
  // Si hay error de autenticación, retornamos la respuesta de error
  if (authError) return authError;

  try {
    // Parseamos el body del request para obtener el ID de la posición
    const { positionId } = await req.json();

    // Validamos que el positionId esté presente
    if (!positionId) {
      return NextResponse.json(
        { error: 'Missing required field: positionId' },
        { status: 400 }
      );
    }

    // Ejecutamos una transacción atómica para garantizar consistencia
    const result = await prisma.$transaction(async (tx) => {
      // Buscamos la posición por su ID
      const position = await tx.position.findUnique({
        where: { id: positionId }
      });

      // Si la posición no existe, lanzamos error
      if (!position) {
        throw new Error('Position not found');
      }

      // El usuario pierde todo el margen (PnL negativo igual al margen)
      const pnl = -Number(position.margin);

      // Creamos el registro en TradeHistory con sizeUsd
      const tradeHistory = await tx.tradeHistory.create({
        data: {
          userId: position.userId,
          market: position.market,
          side: position.side,
          sizeUsd: position.sizeUsd,
          entryPrice: position.entryPrice,
          closePrice: position.liquidationPrice,
          pnl,
          closeReason: 'LIQUIDATED'
        }
      });

      // Borramos la posición (no devolvemos nada al usuario)
      await tx.position.delete({
        where: { id: positionId }
      });

      // Retornamos el tradeHistory y el PnL
      return { tradeHistory, pnl };
    });

    // Retornamos respuesta exitosa con el tradeHistory y el PnL
    return NextResponse.json({
      success: true,
      tradeHistory: result.tradeHistory,
      pnl: result.pnl
    });

  } catch (error: any) {
    // Logueamos el error para debugging
    console.error('Liquidation error:', error);
    
    // Si el error es que la posición no existe, retornamos 404
    if (error.message === 'Position not found') {
      return NextResponse.json(
        { error: 'Position not found' },
        { status: 404 }
      );
    }

    // Retornamos error genérico de servidor
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
