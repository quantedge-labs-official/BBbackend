// Importamos WebSocket para conectar con los WebSockets de dYdX y Hyperliquid
import WebSocket from 'ws';
// Importamos el cliente de Prisma para interactuar con la base de datos
import { prisma } from './lib/prisma';
// Importamos los enums de Prisma para usar los tipos de Mercado y Dirección
import { Market, Side } from '@prisma/client';

// Obtenemos la API_SECRET_KEY de las variables de entorno
const API_SECRET_KEY = process.env.API_SECRET_KEY || '';
// Obtenemos la URL base de la API desde las variables de entorno
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// Objeto para almacenar los precios actuales de cada mercado en memoria
const prices: Record<string, number> = {
  'BTC-USD': 0,
  'ETH-USD': 0,
  'SPCX': 0
};

// Objeto para almacenar los timestamps de la última actualización de precio de cada mercado
const priceTimestamps: Record<string, number> = {
  'BTC-USD': 0,
  'ETH-USD': 0,
  'SPCX': 0
};

// Array para cachear las posiciones activas en memoria
let positionsCache: any[] = [];
// Array para cachear las órdenes pendientes en memoria
let pendingOrdersCache: any[] = [];

// Definimos el intervalo de refresh de cache a 1000ms (1 segundo) para menor latencia
const CACHE_REFRESH_INTERVAL = 1000;
// Definimos el tiempo máximo de antigüedad de un precio (2000ms) para evitar precios congelados
const STALE_PRICE_THRESHOLD = 2000;

// Función para recargar la cache de posiciones y órdenes pendientes desde la base de datos
async function refreshCache() {
  try {
    // Obtenemos todas las posiciones activas de la base de datos SIN incluir el usuario (previene colapso de memoria)
    positionsCache = await prisma.position.findMany({
      // NO incluimos el usuario para evitar cargar datos innecesarios
      // include: { user: true }
    });
    
    // Obtenemos todas las órdenes pendientes de la base de datos SIN incluir el usuario (previene colapso de memoria)
    pendingOrdersCache = await prisma.pendingOrder.findMany({
      // NO incluimos el usuario para evitar cargar datos innecesarios
      // include: { user: true }
    });
    
    // Logueamos el estado de la cache para monitoreo
    console.log(`[Cache] Positions: ${positionsCache.length}, PendingOrders: ${pendingOrdersCache.length}`);
  } catch (error) {
    // Logueamos cualquier error al refrescar la cache
    console.error('[Cache] Error refreshing cache:', error);
  }
}

// Función para conectar al WebSocket de dYdX v4 (BTC y ETH)
function connectDydxWebSocket() {
  // Creamos una conexión WebSocket con la URL de dYdX v4
  const ws = new WebSocket('wss://indexer.dydx.trade/v4/ws');
  
  // Manejador de evento cuando la conexión se abre
  ws.on('open', () => {
    console.log('[dYdX] WebSocket connected');
    
    // Suscribimos al mercado BTC-USD
    ws.send(JSON.stringify({
      type: 'subscribe',
      channel: 'v4_markets',
      id: 'BTC-USD'
    }));
    
    // Suscribimos al mercado ETH-USD
    ws.send(JSON.stringify({
      type: 'subscribe',
      channel: 'v4_markets',
      id: 'ETH-USD'
    }));
  });
  
  // Manejador de evento cuando recibimos un mensaje del WebSocket
  ws.on('message', (data) => {
    try {
      // Parseamos el mensaje recibido
      const message = JSON.parse(data.toString());
      
      // Si el mensaje es del canal de mercados y contiene datos
      if (message.channel === 'v4_markets' && message.contents) {
        // Extraemos los datos del mercado
        const marketData = message.contents;
        // Obtenemos el ID del mercado
        const marketId = marketData.market;
        
        // Si el mercado es BTC-USD o ETH-USD
        if (marketId === 'BTC-USD' || marketId === 'ETH-USD') {
          // Parseamos el precio del índice
          const price = parseFloat(marketData.indexPrice);
          // Actualizamos el precio en memoria
          prices[marketId] = price;
          // Actualizamos el timestamp de la última actualización
          priceTimestamps[marketId] = Date.now();
          // Logueamos el precio recibido
          console.log(`[dYdX] ${marketId} price: ${price}`);
          // Evaluamos si se deben ejecutar liquidaciones u órdenes
          evaluateConditions();
        }
      }
    } catch (error) {
      // Logueamos cualquier error al parsear el mensaje
      console.error('[dYdX] Error parsing message:', error);
    }
  });
  
  // Manejador de evento de error del WebSocket
  ws.on('error', (error) => {
    console.error('[dYdX] WebSocket error:', error);
  });
  
  // Manejador de evento cuando la conexión se cierra
  ws.on('close', () => {
    console.log('[dYdX] WebSocket closed, reconnecting in 5s...');
    // Reintentamos la conexión después de 5 segundos
    setTimeout(connectDydxWebSocket, 5000);
  });
}

// Función para conectar al WebSocket de Hyperliquid (SPCX)
function connectHyperliquidWebSocket() {
  // Creamos una conexión WebSocket con la URL de Hyperliquid
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  
  // Manejador de evento cuando la conexión se abre
  ws.on('open', () => {
    console.log('[Hyperliquid] WebSocket connected');
    
    // Suscribimos a todos los mid prices (precios medios)
    ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: {
        type: 'allMids'
      }
    }));
  });
  
  // Manejador de evento cuando recibimos un mensaje del WebSocket
  ws.on('message', (data) => {
    try {
      // Parseamos el mensaje recibido
      const message = JSON.parse(data.toString());
      
      // Si el mensaje es del canal de mid prices y contiene datos
      if (message.channel === 'allMids' && message.data) {
        // Extraemos los mid prices
        const mids = message.data;
        // Si existe el precio de SPCX
        if (mids.SPCX) {
          // Parseamos el precio
          const price = parseFloat(mids.SPCX);
          // Actualizamos el precio en memoria
          prices['SPCX'] = price;
          // Actualizamos el timestamp de la última actualización
          priceTimestamps['SPCX'] = Date.now();
          // Logueamos el precio recibido
          console.log(`[Hyperliquid] SPCX price: ${price}`);
          // Evaluamos si se deben ejecutar liquidaciones u órdenes
          evaluateConditions();
        }
      }
    } catch (error) {
      // Logueamos cualquier error al parsear el mensaje
      console.error('[Hyperliquid] Error parsing message:', error);
    }
  });
  
  // Manejador de evento de error del WebSocket
  ws.on('error', (error) => {
    console.error('[Hyperliquid] WebSocket error:', error);
  });
  
  // Manejador de evento cuando la conexión se cierra
  ws.on('close', () => {
    console.log('[Hyperliquid] WebSocket closed, reconnecting in 5s...');
    // Reintentamos la conexión después de 5 segundos
    setTimeout(connectHyperliquidWebSocket, 5000);
  });
}

// Función para evaluar condiciones de liquidación y ejecución de órdenes
async function evaluateConditions() {
  try {
    // Creamos un array para almacenar las promesas de liquidación
    const liquidationPromises: Promise<void>[] = [];
    // Creamos un array para almacenar las promesas de ejecución de SL/TP
    const slTpPromises: Promise<void>[] = [];
    // Creamos un array para almacenar las promesas de ejecución de órdenes limit
    const limitPromises: Promise<void>[] = [];

    // Iteramos sobre las posiciones para evaluar liquidación, SL y TP
    for (const position of positionsCache) {
      // Determinamos la clave del mercado según el enum de Prisma
      const marketKey = position.market === 'BTC_USD' ? 'BTC-USD' : 
                       position.market === 'ETH_USD' ? 'ETH-USD' : 'SPCX';
      // Obtenemos el precio actual del mercado
      const currentPrice = prices[marketKey];
      // Obtenemos el timestamp de la última actualización del precio
      const priceTimestamp = priceTimestamps[marketKey];
      
      // Si no hay precio o es 0, saltamos esta posición
      if (!currentPrice || currentPrice === 0) continue;
      
      // Si el precio tiene más de 2000ms de antigüedad (stale price), saltamos esta posición
      if (Date.now() - priceTimestamp > STALE_PRICE_THRESHOLD) {
        console.log(`[Stale Price] Skipping ${marketKey} - Price is ${Date.now() - priceTimestamp}ms old`);
        continue;
      }
      
      // Parseamos el precio de liquidación
      const liquidationPrice = parseFloat(position.liquidationPrice);
      // Parseamos el precio de Stop Loss si existe
      const stopLossPrice = position.stopLossPrice ? parseFloat(position.stopLossPrice) : null;
      // Parseamos el precio de Take Profit si existe
      const takeProfitPrice = position.takeProfitPrice ? parseFloat(position.takeProfitPrice) : null;
      
      // Evaluación de Liquidación para posiciones LONG
      if (position.side === 'LONG' && currentPrice <= liquidationPrice) {
        console.log(`[Liquidation] LONG ${position.market} - Price: ${currentPrice} <= Liq: ${liquidationPrice}`);
        // Añadimos la promesa de liquidación al array (sin await)
        liquidationPromises.push(liquidatePosition(position.id));
      } 
      // Evaluación de Liquidación para posiciones SHORT
      else if (position.side === 'SHORT' && currentPrice >= liquidationPrice) {
        console.log(`[Liquidation] SHORT ${position.market} - Price: ${currentPrice} >= Liq: ${liquidationPrice}`);
        // Añadimos la promesa de liquidación al array (sin await)
        liquidationPromises.push(liquidatePosition(position.id));
      }
      
      // Evaluación de Stop Loss si está configurado
      if (stopLossPrice) {
        // Si es LONG y el precio baja al Stop Loss
        if (position.side === 'LONG' && currentPrice <= stopLossPrice) {
          console.log(`[SL] LONG ${position.market} - Price: ${currentPrice} <= SL: ${stopLossPrice}`);
          // Añadimos la promesa de ejecución SL al array (sin await)
          slTpPromises.push(executeSlTp(position.id, currentPrice, 'SL'));
        } 
        // Si es SHORT y el precio sube al Stop Loss
        else if (position.side === 'SHORT' && currentPrice >= stopLossPrice) {
          console.log(`[SL] SHORT ${position.market} - Price: ${currentPrice} >= SL: ${stopLossPrice}`);
          // Añadimos la promesa de ejecución SL al array (sin await)
          slTpPromises.push(executeSlTp(position.id, currentPrice, 'SL'));
        }
      }
      
      // Evaluación de Take Profit si está configurado
      if (takeProfitPrice) {
        // Si es LONG y el precio sube al Take Profit
        if (position.side === 'LONG' && currentPrice >= takeProfitPrice) {
          console.log(`[TP] LONG ${position.market} - Price: ${currentPrice} >= TP: ${takeProfitPrice}`);
          // Añadimos la promesa de ejecución TP al array (sin await)
          slTpPromises.push(executeSlTp(position.id, currentPrice, 'TP'));
        } 
        // Si es SHORT y el precio baja al Take Profit
        else if (position.side === 'SHORT' && currentPrice <= takeProfitPrice) {
          console.log(`[TP] SHORT ${position.market} - Price: ${currentPrice} <= TP: ${takeProfitPrice}`);
          // Añadimos la promesa de ejecución TP al array (sin await)
          slTpPromises.push(executeSlTp(position.id, currentPrice, 'TP'));
        }
      }
    }
    
    // Iteramos sobre las órdenes pendientes para evaluar ejecución de órdenes limit
    for (const order of pendingOrdersCache) {
      // Determinamos la clave del mercado según el enum de Prisma
      const marketKey = order.market === 'BTC_USD' ? 'BTC-USD' : 
                       order.market === 'ETH_USD' ? 'ETH-USD' : 'SPCX';
      // Obtenemos el precio actual del mercado
      const currentPrice = prices[marketKey];
      // Obtenemos el timestamp de la última actualización del precio
      const priceTimestamp = priceTimestamps[marketKey];
      
      // Si no hay precio o es 0, saltamos esta orden
      if (!currentPrice || currentPrice === 0) continue;
      
      // Si el precio tiene más de 2000ms de antigüedad (stale price), saltamos esta orden
      if (Date.now() - priceTimestamp > STALE_PRICE_THRESHOLD) {
        console.log(`[Stale Price] Skipping ${marketKey} - Price is ${Date.now() - priceTimestamp}ms old`);
        continue;
      }
      
      // Parseamos el precio límite
      const limitPrice = parseFloat(order.limitPrice);
      
      // Evaluación de ejecución de orden limit para LONG
      if (order.side === 'LONG' && currentPrice <= limitPrice) {
        console.log(`[Limit] LONG ${order.market} - Price: ${currentPrice} <= Limit: ${limitPrice}`);
        // Añadimos la promesa de ejecución de orden limit al array (sin await)
        limitPromises.push(executeLimitOrder(order.id, currentPrice));
      } 
      // Evaluación de ejecución de orden limit para SHORT
      else if (order.side === 'SHORT' && currentPrice >= limitPrice) {
        console.log(`[Limit] SHORT ${order.market} - Price: ${currentPrice} >= Limit: ${limitPrice}`);
        // Añadimos la promesa de ejecución de orden limit al array (sin await)
        limitPromises.push(executeLimitOrder(order.id, currentPrice));
      }
    }
    
    // Ejecutamos todas las liquidaciones en paralelo usando Promise.all()
    if (liquidationPromises.length > 0) {
      await Promise.all(liquidationPromises);
    }
    
    // Ejecutamos todas las ejecuciones de SL/TP en paralelo usando Promise.all()
    if (slTpPromises.length > 0) {
      await Promise.all(slTpPromises);
    }
    
    // Ejecutamos todas las ejecuciones de órdenes limit en paralelo usando Promise.all()
    if (limitPromises.length > 0) {
      await Promise.all(limitPromises);
    }
    
  } catch (error) {
    // Logueamos cualquier error al evaluar condiciones
    console.error('[Evaluation] Error evaluating conditions:', error);
  }
}

// Función para llamar al endpoint de liquidación
async function liquidatePosition(positionId: string) {
  try {
    // Hacemos una petición POST al endpoint de liquidación
    const response = await fetch(`${API_BASE_URL}/api/order/liquidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Incluimos el API_SECRET_KEY en los headers
        'x-api-secret-key': API_SECRET_KEY
      },
      body: JSON.stringify({ positionId })
    });
    
    // Parseamos la respuesta
    const result = await response.json();
    
    // Si la liquidación fue exitosa
    if (result.success) {
      console.log(`[Liquidation] Success - Position ${positionId}`);
      // Recargamos la cache inmediatamente para reflejar los cambios
      await refreshCache();
    } else {
      // Logueamos el error si la liquidación falló
      console.error(`[Liquidation] Failed - Position ${positionId}:`, result.error);
    }
  } catch (error) {
    // Logueamos cualquier error al liquidar
    console.error(`[Liquidation] Error - Position ${positionId}:`, error);
  }
}

// Función para llamar al endpoint de ejecución de SL/TP
async function executeSlTp(positionId: string, currentPrice: number, closeReason: 'SL' | 'TP') {
  try {
    // Hacemos una petición POST al endpoint de ejecución de SL/TP
    const response = await fetch(`${API_BASE_URL}/api/order/execute-sl-tp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Incluimos el API_SECRET_KEY en los headers
        'x-api-secret-key': API_SECRET_KEY
      },
      body: JSON.stringify({ positionId, currentPrice, closeReason })
    });
    
    // Parseamos la respuesta
    const result = await response.json();
    
    // Si la ejecución fue exitosa
    if (result.success) {
      console.log(`[${closeReason}] Success - Position ${positionId}`);
      // Recargamos la cache inmediatamente para reflejar los cambios
      await refreshCache();
    } else {
      // Logueamos el error si la ejecución falló
      console.error(`[${closeReason}] Failed - Position ${positionId}:`, result.error);
    }
  } catch (error) {
    // Logueamos cualquier error al ejecutar SL/TP
    console.error(`[${closeReason}] Error - Position ${positionId}:`, error);
  }
}

// Función para llamar al endpoint de ejecución de orden limit
async function executeLimitOrder(pendingOrderId: string, currentPrice: number) {
  try {
    // Hacemos una petición POST al endpoint de ejecución de orden limit
    const response = await fetch(`${API_BASE_URL}/api/order/execute-limit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Incluimos el API_SECRET_KEY en los headers
        'x-api-secret-key': API_SECRET_KEY
      },
      body: JSON.stringify({ pendingOrderId, currentPrice })
    });
    
    // Parseamos la respuesta
    const result = await response.json();
    
    // Si la ejecución fue exitosa
    if (result.success) {
      console.log(`[Limit] Success - Order ${pendingOrderId}`);
      // Recargamos la cache inmediatamente para reflejar los cambios
      await refreshCache();
    } else {
      // Logueamos el error si la ejecución falló
      console.error(`[Limit] Failed - Order ${pendingOrderId}:`, result.error);
    }
  } catch (error) {
    // Logueamos cualquier error al ejecutar la orden limit
    console.error(`[Limit] Error - Order ${pendingOrderId}:`, error);
  }
}

// Función para iniciar el sniper
async function startSniper() {
  console.log('[Sniper] Starting...');
  
  // Cargamos la cache inicial
  await refreshCache();
  
  // Iniciamos el intervalo de refresh de cache cada 1000ms
  setInterval(refreshCache, CACHE_REFRESH_INTERVAL);
  
  // Conectamos al WebSocket de dYdX
  connectDydxWebSocket();
  // Conectamos al WebSocket de Hyperliquid
  connectHyperliquidWebSocket();
  
  console.log('[Sniper] Running 24/7...');
}

// Manejador para shutdown graceful al recibir SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  console.log('[Sniper] Shutting down gracefully...');
  // Terminamos el proceso
  process.exit(0);
});

// Manejador para shutdown graceful al recibir SIGTERM
process.on('SIGTERM', () => {
  console.log('[Sniper] Shutting down gracefully...');
  // Terminamos el proceso
  process.exit(0);
});

// Iniciamos el sniper
startSniper().catch(console.error);
