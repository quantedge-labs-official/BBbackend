// Importamos los tipos de Next.js para manejar requests y responses
import { NextRequest, NextResponse } from 'next/server';
// Importamos el cliente de Prisma para interactuar con la base de datos
import { prisma } from '@/lib/prisma';
// Importamos las utilidades para validaciones
import { validatePositiveNumber } from '@/lib/utils';

// Función handler para el endpoint POST /api/order/cancel-limit (PÚBLICO)
export async function POST(req: NextRequest) {
  try {
    // Parseamos el body del request para obtener los datos de cancelación
    const { walletAddress, pendingOrderId } = await req.json();

    // Validamos que el walletAddress esté presente
    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Missing required field: walletAddress' },
        { status: 400 }
      );
    }

    // Validamos que el pendingOrderId esté presente
    if (!pendingOrderId) {
      return NextResponse.json(
        { error: 'Missing required field: pendingOrderId' },
        { status: 400 }
      );
    }

    // Ejecutamos una transacción atómica para garantizar consistencia
    const result = await prisma.$transaction(async (tx) => {
      // Buscamos el usuario por walletAddress
      const user = await tx.user.findUnique({
        where: { walletAddress }
      });

      // Si el usuario no existe, lanzamos error
      if (!user) {
        throw new Error('User not found');
      }

      // Buscamos la orden pendiente por su ID
      const pendingOrder = await tx.pendingOrder.findUnique({
        where: { id: pendingOrderId }
      });

      // Si la orden pendiente no existe, lanzamos error
      if (!pendingOrder) {
        throw new Error('Pending order not found');
      }

      // Verificamos que la orden pertenezca al usuario
      if (pendingOrder.userId !== user.id) {
        throw new Error('Unauthorized');
      }

      // Calculamos el monto a devolver (Margen + Comisión Maker)
      const makerFee = Number(pendingOrder.sizeUsd) * 0.0002; // 0.02%
      const returnAmount = Number(pendingOrder.margin) + makerFee;

      // Actualizamos el balance del usuario devolviendo el margen + maker fee
      const updatedUser = await tx.user.update({
        where: { 
          id: user.id
          // Para incrementos, no es crítico validar el saldo mínimo
          // pero mantenemos la consistencia del patrón de transacciones
        },
        data: {
          availableBalance: {
            increment: returnAmount
          }
        }
      });

      // Borramos la orden pendiente
      await tx.pendingOrder.delete({
        where: { id: pendingOrderId }
      });

      // Retornamos el usuario actualizado y el monto devuelto
      return { updatedUser, returnAmount };
    });

    // Retornamos respuesta exitosa con el nuevo balance y el monto devuelto
    return NextResponse.json({
      success: true,
      newBalance: result.updatedUser.availableBalance,
      returnedAmount: result.returnAmount
    });

  } catch (error: any) {
    // Logueamos el error para debugging
    console.error('Cancel limit order error:', error);
    
    // Si el error es que el usuario no existe, retornamos 404
    if (error.message === 'User not found') {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }
    
    // Si el error es que la orden no existe, retornamos 404
    if (error.message === 'Pending order not found') {
      return NextResponse.json(
        { error: 'Pending order not found' },
        { status: 404 }
      );
    }
    
    // Si el error es de autorización, retornamos 403
    if (error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 403 }
      );
    }

    // Retornamos error genérico de servidor
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
