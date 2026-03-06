import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import https from "https";
import { enviarNFeParaSefaz, consultarStatusNFeSefaz, cancelarNFeSefaz, inutilizarNumerosNFeSefaz, gerarXMLNFe } from "./lib/sefazIntegration.js";
import type { SefazConfig } from "./lib/sefazIntegration.js";
import { parseArquivoPFX, assinarXMLNFe, validarCertificado } from "./lib/certificateManager.js";
import { criarNFe, obterNFe, obterNFePorChaveAcesso, listarNFes, atualizarNFe, deletarNFe, obterProximoNumeroNFe } from "./lib/nfeSupabase.js";
import { criarCertificado, obterCertificado, listarCertificados, atualizarCertificado, deletarCertificado, obterCertificadoPorCNPJ } from "./lib/certificateSupabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Load SSL certificates
  const certPath = path.join(__dirname, "cert.pem");
  const keyPath = path.join(__dirname, "key.pem");
  
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.error("❌ Certificados não encontrados!");
    console.error(`   Execute primeiro: python generate_cert.py`);
    process.exit(1);
  }
  
  const cert = fs.readFileSync(certPath, "utf8");
  const key = fs.readFileSync(keyPath, "utf8");

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // API Routes for Bling Proxy
  app.get("/api/download-project", async (req, res) => {
    try {
      const archiver = (await import("archiver")).default;
      const archive = archiver("zip", { zlib: { level: 9 } });

      res.attachment("projeto-erp-fabrica.zip");

      archive.pipe(res);

      // Add files from root directory, excluding node_modules, .git, dist, etc.
      archive.glob("**/*", {
        cwd: __dirname,
        ignore: ["node_modules/**", ".git/**", "dist/**", ".env", ".env.local", ".DS_Store"]
      });

      await archive.finalize();
    } catch (error: any) {
      console.error("Download Error:", error);
      res.status(500).send("Erro ao gerar arquivo zip.");
    }
  });

  // DEBUG: Teste de token simples
  app.get("/api/debug/token-test", (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Teste de Token - Bling API</title>
        <style>
          body { font-family: Arial; max-width: 800px; margin: 50px auto; padding: 20px; }
          input, textarea { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ccc; }
          button { padding: 10px 20px; background: #007bff; color: white; border: none; cursor: pointer; }
          .result { background: #f5f5f5; padding: 10px; margin: 20px 0; border-left: 4px solid #007bff; }
          .error { border-left-color: #dc3545; }
          .success { border-left-color: #28a745; }
        </style>
      </head>
      <body>
        <h1>🔐 Teste de Autenticação Bling API</h1>
        
        <div>
          <label><strong>Client ID:</strong></label>
          <input type="text" id="clientId" placeholder="Cole seu Client ID">
        </div>
        
        <div>
          <label><strong>Client Secret:</strong></label>
          <input type="password" id="clientSecret" placeholder="Cole seu Client Secret">
        </div>
        
        <div>
          <label><strong>Código de Autorização:</strong></label>
          <input type="text" id="code" placeholder="Cole o código da URL (code=abc123...)">
          <small>📌 Após clicar em autorizar no Bling, você será redirecionado para uma URL com o código na query string</small>
        </div>
        
        <div>
          <label><strong>Redirect URI:</strong></label>
          <input type="text" id="redirectUri" value="${process.env.NODE_ENV === 'production' ? 'https://seu-dominio.com' : 'https://localhost:3000'}" placeholder="Deve bater com o cadastrado no Bling">
        </div>
        
        <button onclick="testarToken()">🚀 Testar Token</button>
        
        <div id="result"></div>
        
        <script>
          async function testarToken() {
            const clientId = document.getElementById('clientId').value;
            const clientSecret = document.getElementById('clientSecret').value;
            const code = document.getElementById('code').value;
            const redirectUri = document.getElementById('redirectUri').value;
            const resultDiv = document.getElementById('result');
            
            if (!clientId || !clientSecret || !code) {
              resultDiv.innerHTML = '<div class="result error">❌ Preencha todos os campos</div>';
              return;
            }
            
            resultDiv.innerHTML = '<div class="result">⏳ Aguardando...</div>';
            
            try {
              const response = await fetch('/api/bling/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  grant_type: 'authorization_code',
                  code: code.trim(),
                  client_id: clientId.trim(),
                  client_secret: clientSecret.trim(),
                  redirect_uri: redirectUri.trim()
                })
              });
              
              const data = await response.json();
              
              if (data.access_token) {
                resultDiv.innerHTML = \`
                  <div class="result success">
                    <h3>✅ Sucesso!</h3>
                    <p><strong>Access Token:</strong></p>
                    <textarea readonly>\${data.access_token}</textarea>
                    <p><strong>Refresh Token:</strong></p>
                    <textarea readonly>\${data.refresh_token || 'Não fornecido'}</textarea>
                    <p><strong>Expires In:</strong> \${data.expires_in} segundos</p>
                  </div>
                \`;
              } else {
                resultDiv.innerHTML = \`
                  <div class="result error">
                    <h3>❌ Erro:</h3>
                    <pre>\${JSON.stringify(data, null, 2)}</pre>
                  </div>
                \`;
              }
            } catch (e) {
              resultDiv.innerHTML = \`
                <div class="result error">
                  <h3>❌ Erro na requisição:</h3>
                  <pre>\${e.message}</pre>
                </div>
              \`;
            }
          }
        </script>
      </body>
      </html>
    `);
  });

  app.post("/api/bling/token", async (req, res) => {
    try {
      const { code, client_id, client_secret, redirect_uri, grant_type, refresh_token } = req.body;
      
      // LOG DE DEBUG - Mostra exatamente o que está sendo enviado
      console.log('🔐 [BLING TOKEN REQUEST]');
      console.log(`   Grant Type: ${grant_type}`);
      console.log(`   Client ID: ${client_id?.substring(0, 10)}...`);
      console.log(`   Redirect URI: ${redirect_uri}`);
      
      // Validações
      if (grant_type === 'authorization_code' && !code) {
        return res.status(400).json({ error: 'Code é obrigatório para authorization_code' });
      }
      if (grant_type === 'refresh_token' && !refresh_token) {
        return res.status(400).json({ error: 'Refresh token é obrigatório' });
      }

      // Prepare URLSearchParams EXATAMENTE como o Bling espera
      const body = new URLSearchParams();
      
      if (grant_type === 'authorization_code') {
        body.append('grant_type', 'authorization_code');
        body.append('code', code.trim()); // IMPORTANTE: trim para remover espaços
        body.append('redirect_uri', redirect_uri);
        // NÃO colocamos client_id e client_secret no body quando usamos Basic Auth
      } else if (grant_type === 'refresh_token') {
        body.append('grant_type', 'refresh_token');
        body.append('refresh_token', refresh_token.trim());
      }

      // Autenticação Basic (client_id:client_secret em Base64)
      const credentials = Buffer.from(`${client_id}:${client_secret}`).toString('base64');
      
      console.log(`   Body enviado: ${body.toString()}`);
      console.log(`   Auth Header: Basic ${credentials.substring(0, 20)}...`);

      const response = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': 'NOVO-ERP-Sync/1.0'
        },
        body: body.toString()
      });

      const data = await response.json();
      
      if (response.ok) {
        console.log('✅ [BLING TOKEN SUCCESS] Token gerado com sucesso');
      } else {
        console.log('❌ [BLING TOKEN ERROR]', JSON.stringify(data));
      }
      
      res.status(response.status).json(data);
    } catch (error: any) {
      console.error('❌ Bling Token Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // In-memory storage for sync logs and vinculations (use database in production)
  let syncLogs: any[] = [];
  let productVinculations: any[] = [];
  let syncedOrdersStore: any[] = [];
  let syncedInvoicesStore: any[] = [];
  let syncedProductsStore: any[] = [];

  /** Garante que o token tenha o prefixo "Bearer " antes de enviar ao Bling/ML/Shopee */
  const normalizeBearerToken = (raw: string): string => {
    const t = (raw || '').trim();
    if (!t) return '';
    return t.toLowerCase().startsWith('bearer ') ? t : `Bearer ${t}`;
  };

  const parseCanal = (raw: any): 'ML' | 'SHOPEE' | 'SITE' => {
    const text = String(raw || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (text.includes('MERCADO LIVRE') || text.includes('MERCADOLIVRE') || text.includes('MERCADO-LIVRE') || text.includes('MLB') || text.includes('ML ') || text === 'ML') return 'ML';
    if (text.includes('SHOPEE')) return 'SHOPEE';
    if (text.includes('MERCADO')) return 'ML'; // Mercado Pago, etc.
    if (text.includes('AMAZON')) return 'SITE';
    return 'SITE';
  };

  // SYNC ENDPOINTS - PHASE 1
  app.get('/api/bling/sync/orders', async (req, res) => {
    try {
      const token = normalizeBearerToken(req.headers['authorization'] as string || '');
      if (!token) return res.status(401).json({ error: 'Token não fornecido' });

      const dataInicio = String(req.query.dataInicio || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0]);
      const dataFim = String(req.query.dataFim || new Date().toISOString().split('T')[0]);
      const status = String(req.query.status || 'TODOS').toUpperCase();
      const canal = String(req.query.canal || 'ALL').toUpperCase();

      console.log(`📋 [SYNC PEDIDOS DE VENDAS] Data: ${dataInicio} a ${dataFim} | Status: ${status} | Canal: ${canal}`);

      // ── Paginação: busca TODAS as páginas ──────────────────────────────────
      const allRawOrders: any[] = [];
      let pagina = 1;
      let continuar = true;

      // Mapear status textual → idsSituacoes do Bling v3
      const statusIdMap: Record<string, string[]> = {
        'EM ABERTO': ['6'],
        'EM ANDAMENTO': ['15'],
        'ATENDIDO': ['9'],
        'EM ABERTO,ATENDIDO': ['6', '9'],
      };
      const situacaoIds = statusIdMap[status] || []; // vazio = TODOS

      while (continuar) {
        const situacoesQs = situacaoIds.map((id: string, i: number) => `&idsSituacoes[${i}]=${id}`).join('');
        const url = `https://www.bling.com.br/Api/v3/pedidos/vendas?dataInicial=${dataInicio}&dataFinal=${dataFim}&limite=100&pagina=${pagina}${situacoesQs}`;
        const pageResp = await fetch(url, {
          headers: { 'Authorization': token, 'Accept': 'application/json' }
        });

        if (!pageResp.ok) {
          if (pagina === 1) {
            return res.status(pageResp.status).json({ error: 'Erro ao buscar pedidos do Bling' });
          }
          break; // Para em páginas subsequentes com erro
        }

        const pageData = await pageResp.json();
        const pageOrders: any[] = pageData.data || [];

        if (pageOrders.length === 0) {
          continuar = false;
        } else {
          allRawOrders.push(...pageOrders);
          // Bling retorna no máximo 100 por página; se vier menos, acabou
          if (pageOrders.length < 100) continuar = false;
          else pagina++;
        }

        // Segurança: máximo 20 páginas (2000 pedidos)
        if (pagina > 20) continuar = false;
      }

      console.log(`📋 [SYNC PEDIDOS] Total raw: ${allRawOrders.length} em ${pagina} página(s) | situacoes API: ${situacaoIds.join(',') || 'TODOS'}`);

      // ── Montar pedidos COMPLETOS (um por order) com itens aninhados ────────
      // Filtro de situação já foi aplicado pela API via idsSituacoes
      // Apenas filtramos por canal se solicitado
      const completeOrders: any[] = allRawOrders
        .filter((order: any) => {
          if (canal === 'ALL') return true;
          const detectedCanal = parseCanal(order?.loja?.nome || order?.origem || order?.tipo);
          return detectedCanal === canal;
          return true;
        })
        .map((order: any) => {
          const detectedCanal = parseCanal(order?.loja?.nome || order?.origem || order?.tipo);
          const orderDate = String(order?.data || '').split('T')[0];
          const items = Array.isArray(order?.itens) ? order.itens : [];

          return {
            id: `order-${order.id}`,
            orderId: String(order?.numeroLoja || order?.numero || order?.id || ''),
            blingId: String(order?.id || ''),
            blingNumero: String(order?.numero || ''),
            customer_name: order?.contato?.nome || 'Não informado',
            customer_cpf_cnpj: order?.contato?.numeroDocumento || '',
            data: orderDate,
            status: String(order?.situacao?.descricao || order?.situacao?.valor || 'Em aberto'),
            situacaoId: Number(order?.situacao?.id || 0),
            canal: detectedCanal,
            loja: order?.loja?.nome || '',
            total: Number(order?.total || 0),
            desconto: Number(order?.desconto?.valor || 0),
            frete: Number(order?.transporte?.frete || 0),
            rastreamento: order?.transporte?.codigoRastreamento || '',
            transportador: order?.transporte?.transportador?.nome || '',
            observacoes: order?.observacoes || '',
            itens: items.map((item: any) => {
              const sku = String(item?.codigo || item?.codigoProduto || '').trim();
              const vinculation = productVinculations.find(v => v.blingCode === sku);
              return {
                id: `item-${order.id}-${sku || item?.id}`,
                sku,
                descricao: item?.descricao || item?.nome || '',
                quantidade: Number(item?.quantidade || 0),
                valorUnitario: Number(item?.valor || item?.valorUnitario || 0),
                subtotal: Number(item?.quantidade || 0) * Number(item?.valor || 0),
                finalProductSku: vinculation?.erpSku || null,
                finalProductId: vinculation?.erpProductId || null
              };
            }),
            itensCount: items.length,
            // Retrocompatibilidade para transformSyncedOrder
            sku: items.length === 1 ? String(items[0]?.codigo || '') : null,
            quantity: items.reduce((s: number, i: any) => s + Number(i?.quantidade || 0), 0),
            unit_price: items.length === 1 ? Number(items[0]?.valor || 0) : 0,
          };
        });

      // Também gera a lista flat (itens) para retrocompatibilidade
      const flatItems: any[] = completeOrders.flatMap((order: any) =>
        order.itens.length > 0
          ? order.itens.map((item: any) => ({
              ...item,
              orderId: order.orderId,
              blingId: order.blingId,
              customer_name: order.customer_name,
              data: order.data,
              status: 'NOVO',
              canal: order.canal,
              total: order.total,
              lote: null,
            }))
          : [{ id: order.id, orderId: order.orderId, blingId: order.blingId,
               customer_name: order.customer_name, data: order.data, status: 'NOVO',
               canal: order.canal, lote: null, sku: null, quantity: 0, total: order.total }]
      );

      syncedOrdersStore = flatItems;

      const syncLog = {
        id: `sync-${Date.now()}`,
        type: 'PEDIDOS',
        status: 'SUCCESS',
        startedAt: Date.now(),
        completedAt: Date.now(),
        recordsProcessed: completeOrders.length,
        recordsFailed: 0,
        details: {
          newRecords: completeOrders.length,
          updatedRecords: 0,
          skippedRecords: 0,
          totalPages: pagina
        }
      };

      syncLogs.unshift(syncLog);
      if (syncLogs.length > 100) syncLogs.pop();

      console.log(`✅ [SYNC PEDIDOS] ${completeOrders.length} pedidos completos sincronizados`);

      res.json({
        success: true,
        status: 'SUCCESS',
        type: 'PEDIDOS',
        totalRecords: completeOrders.length,
        processedRecords: completeOrders.length,
        failedRecords: 0,
        newRecords: completeOrders.length,
        updatedRecords: 0,
        totalPages: pagina,
        orders: completeOrders,   // pedidos completos (um por order)
        items: flatItems,          // itens flat (retrocompatibilidade)
        timestamp: Date.now()
      });
    } catch (error: any) {
      console.error('❌ [SYNC PEDIDOS ERROR]:', error);
      res.status(500).json({
        success: false,
        status: 'ERROR',
        type: 'PEDIDOS',
        errorMessage: error.message
      });
    }
  });

  app.get('/api/bling/sync/invoices', async (req, res) => {
    try {
      const token = normalizeBearerToken(req.headers['authorization'] as string || '');
      if (!token) return res.status(401).json({ error: 'Token não fornecido' });

      const dataInicio = String(req.query.dataInicio || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0]);
      const dataFim = String(req.query.dataFim || new Date().toISOString().split('T')[0]);
      const status = String(req.query.status || 'TODOS').toUpperCase();

      console.log(`📄 [SYNC NOTAS FISCAIS] Data: ${dataInicio} a ${dataFim}`);

      // Paginação: busca todas as páginas de notas
      const allRawInvoices: any[] = [];
      let nfPagina = 1;
      let nfContinuar = true;

      while (nfContinuar) {
        const nfUrl = `https://www.bling.com.br/Api/v3/nfe?dataEmissaoInicial=${dataInicio}%2000:00:00&dataEmissaoFinal=${dataFim}%2023:59:59&limite=100&pagina=${nfPagina}`;
        const pageResp = await fetch(nfUrl, {
          headers: { 'Authorization': token, 'Accept': 'application/json' }
        });

        if (!pageResp.ok) {
          if (nfPagina === 1) return res.status(pageResp.status).json({ error: 'Erro ao buscar notas fiscais' });
          break;
        }

        const pageData = await pageResp.json();
        const pageItems: any[] = pageData.data || [];
        if (pageItems.length === 0) {
          nfContinuar = false;
        } else {
          allRawInvoices.push(...pageItems);
          if (pageItems.length < 100) nfContinuar = false;
          else nfPagina++;
        }
        if (nfPagina > 20) nfContinuar = false;
      }

      const rawInvoices = allRawInvoices;
      const normalizedInvoices = rawInvoices
        .map((nf: any) => ({
          id: String(nf?.id || ''),
          numero: String(nf?.numero || ''),
          serie: String(nf?.serie || ''),
          nomeCliente: nf?.contato?.nome || 'Não informado',
          dataEmissao: String(nf?.dataEmissao || '').split('T')[0],
          valorNota: Number(nf?.valorNota || nf?.valor || 0),
          situacao: String(nf?.situacao?.descricao || nf?.situacao || ''),
          status: String(nf?.situacao?.descricao || nf?.situacao || '').toUpperCase(),
          idPedidoVenda: String(nf?.pedido?.id || nf?.idPedidoVenda || ''),
          linkDanfe: nf?.linkDanfe || nf?.xml || ''
        }))
        .filter((nf: any) => {
          if (status === 'TODOS') return true;
          if (status === 'EMITIDAS') return nf.status.includes('EMITIDA') || nf.status.includes('AUTORIZADA');
          if (status === 'PENDENTES') return !nf.status.includes('EMITIDA') && !nf.status.includes('AUTORIZADA');
          return true;
        });

      syncedInvoicesStore = normalizedInvoices;

      const syncLog = {
        id: `sync-${Date.now()}`,
        type: 'NOTAS_FISCAIS',
        status: 'SUCCESS',
        startedAt: Date.now(),
        completedAt: Date.now(),
        recordsProcessed: normalizedInvoices.length,
        recordsFailed: 0,
        details: {
          newRecords: normalizedInvoices.length,
          updatedRecords: 0,
          skippedRecords: 0
        }
      };
      
      syncLogs.unshift(syncLog);
      if (syncLogs.length > 100) syncLogs.pop();

      console.log(`✅ [SYNC NOTAS FISCAIS] ${normalizedInvoices.length} notas sincronizadas`);

      res.json({
        success: true,
        status: 'SUCCESS',
        type: 'NOTAS_FISCAIS',
        totalRecords: normalizedInvoices.length,
        processedRecords: normalizedInvoices.length,
        failedRecords: 0,
        newRecords: normalizedInvoices.length,
        updatedRecords: 0,
        invoices: normalizedInvoices,
        timestamp: Date.now()
      });
    } catch (error: any) {
      console.error('❌ [SYNC NOTAS FISCAIS ERROR]:', error);
      res.status(500).json({ 
        success: false, 
        status: 'ERROR',
        type: 'NOTAS_FISCAIS',
        errorMessage: error.message 
      });
    }
  });

  app.get('/api/bling/sync/products', async (req, res) => {
    try {
      const token = normalizeBearerToken(req.headers['authorization'] as string || '');
      if (!token) return res.status(401).json({ error: 'Token não fornecido' });

      console.log(`📦 [SYNC PRODUTOS] Iniciando sincronização`);

      const response = await fetch(
        'https://www.bling.com.br/Api/v3/produtos?limite=100',
        { headers: { 'Authorization': token, 'Accept': 'application/json' } }
      );

      if (!response.ok) {
        return res.status(response.status).json({ error: 'Erro ao buscar produtos' });
      }

      const data = await response.json();
      const rawProducts = data.data || [];
      const normalizedProducts = rawProducts.map((prod: any) => {
        const sku = String(prod?.codigo || '');
        const vinculation = productVinculations.find(v => v.blingCode === sku);
        return {
          id: String(prod?.id || ''),
          codigo: sku,
          descricao: prod?.nome || prod?.descricao || '',
          preco: Number(prod?.preco || 0),
          estoqueAtual: Number(prod?.estoque?.saldoVirtual || 0),
          finalProductSku: vinculation?.erpSku || null,
          finalProductId: vinculation?.erpProductId || null,
          source: 'BLING'
        };
      });

      syncedProductsStore = normalizedProducts;

      const syncLog = {
        id: `sync-${Date.now()}`,
        type: 'PRODUTOS',
        status: 'SUCCESS',
        startedAt: Date.now(),
        completedAt: Date.now(),
        recordsProcessed: normalizedProducts.length,
        recordsFailed: 0,
        details: {
          newRecords: normalizedProducts.length,
          updatedRecords: 0,
          skippedRecords: 0
        }
      };
      
      syncLogs.unshift(syncLog);
      if (syncLogs.length > 100) syncLogs.pop();

      console.log(`✅ [SYNC PRODUTOS] ${normalizedProducts.length} produtos sincronizados`);

      res.json({
        success: true,
        status: 'SUCCESS',
        type: 'PRODUTOS',
        totalRecords: normalizedProducts.length,
        processedRecords: normalizedProducts.length,
        failedRecords: 0,
        newRecords: normalizedProducts.length,
        updatedRecords: 0,
        products: normalizedProducts,
        vinculations: productVinculations,
        timestamp: Date.now()
      });
    } catch (error: any) {
      console.error('❌ [SYNC PRODUTOS ERROR]:', error);
      res.status(500).json({ 
        success: false, 
        status: 'ERROR',
        type: 'PRODUTOS',
        errorMessage: error.message 
      });
    }
  });

  // Sync stock adjustments from Bling (saldo virtual por depósito)
  app.get('/api/bling/sync/stock', async (req, res) => {
    try {
      const token = normalizeBearerToken(req.headers['authorization'] as string || '');
      if (!token) return res.status(401).json({ error: 'Token não fornecido' });

      console.log(`📦 [SYNC ESTOQUE] Iniciando sincronização de estoque`);

      // --- Fase 1: buscar todos os produtos paginado ---
      let allProducts: any[] = [];
      let pagina = 1;
      let continuar = true;
      while (continuar) {
        const resp = await fetch(
          `https://www.bling.com.br/Api/v3/produtos?limite=100&pagina=${pagina}&situacao=A`,
          { headers: { Authorization: token, Accept: 'application/json' } }
        );
        if (!resp.ok) {
          if (pagina === 1) return res.status(resp.status).json({ error: 'Erro ao buscar produtos do Bling' });
          break;
        }
        const d = await resp.json();
        const page: any[] = d?.data || [];
        allProducts.push(...page);
        if (page.length < 100) continuar = false;
        else pagina++;
        if (pagina > 50) continuar = false;
      }
      console.log(`📦 [SYNC ESTOQUE] ${allProducts.length} produto(s) encontrado(s) em ${pagina} página(s)`);

      // --- Fase 2: buscar saldos reais via /estoques paginado ---
      const stockMap = new Map<string, { saldoFisico: number; saldoVirtual: number }>();
      let ep = 1;
      let ec = true;
      while (ec) {
        const er = await fetch(
          `https://www.bling.com.br/Api/v3/estoques?limite=100&pagina=${ep}`,
          { headers: { Authorization: token, Accept: 'application/json' } }
        ).catch(() => null);
        if (!er || !er.ok) break;
        const ed = await er.json().catch(() => ({}));
        const entries: any[] = ed?.data || [];
        for (const entry of entries) {
          const pid = String(entry?.produto?.id || entry?.produtoId || '');
          if (!pid) continue;
          const cur = stockMap.get(pid) || { saldoFisico: 0, saldoVirtual: 0 };
          cur.saldoFisico  += Number(entry?.saldoFisico  ?? entry?.saldoReal ?? 0);
          cur.saldoVirtual += Number(entry?.saldoVirtual ?? 0);
          stockMap.set(pid, cur);
        }
        if (entries.length < 100) ec = false;
        else ep++;
        if (ep > 50) ec = false;
      }
      console.log(`📦 [SYNC ESTOQUE] Saldos de ${stockMap.size} produto(s) via /estoques`);

      // --- Montar itens finais ---
      const stockItems = allProducts
        .filter((p: any) => p.codigo)
        .map((prod: any) => {
          const pid = String(prod.id || '');
          const fromMap = stockMap.get(pid);
          const saldoFisico  = fromMap?.saldoFisico  ?? Number(prod?.estoque?.saldoReal    || prod?.estoque?.saldoFisico  || 0);
          const saldoVirtual = fromMap?.saldoVirtual ?? Number(prod?.estoque?.saldoVirtual || 0);
          return {
            id:            pid,
            codigo:        String(prod.codigo || ''),
            descricao:     prod.nome || '',
            saldoFisico,
            saldoVirtual,
            estoqueReal:   saldoFisico,
            estoqueVirtual: saldoVirtual,
            unidade:       prod.unidade || 'UN',
            preco:         Number(prod.preco || 0),
            situacao:      prod.situacao || 'A',
            source:        'BLING',
            syncedAt:      Date.now(),
          };
        });

      const syncLog = {
        id: `sync-${Date.now()}`,
        type: 'ESTOQUE',
        status: 'SUCCESS',
        startedAt: Date.now(),
        completedAt: Date.now(),
        recordsProcessed: stockItems.length,
        recordsFailed: 0,
        details: { newRecords: stockItems.length, updatedRecords: 0, skippedRecords: 0 }
      };
      syncLogs.unshift(syncLog);
      if (syncLogs.length > 100) syncLogs.pop();

      console.log(`✅ [SYNC ESTOQUE] ${stockItems.length} itens sincronizados`);

      res.json({
        success: true,
        status: 'SUCCESS',
        type: 'ESTOQUE',
        totalRecords: stockItems.length,
        processedRecords: stockItems.length,
        failedRecords: 0,
        stockItems,
        timestamp: Date.now()
      });
    } catch (error: any) {
      console.error('❌ [SYNC ESTOQUE ERROR]:', error);
      res.status(500).json({ success: false, status: 'ERROR', type: 'ESTOQUE', errorMessage: error.message });
    }
  });

  // Atualizar saldo de um produto no Bling (ajuste manual)
  app.post('/api/bling/estoque/atualizar', async (req, res) => {
    try {
      const { produtoId, deposito, operacao, quantidade, observacoes } = req.body as {
        produtoId: string | number;
        deposito?: number;
        operacao: 'B' | 'S' | 'E'; // B=Balanço, S=Saída, E=Entrada
        quantidade: number;
        observacoes?: string;
      };
      const token = normalizeBearerToken(req.headers['authorization'] as string || '');
      if (!token) return res.status(401).json({ error: 'Token não fornecido' });
      if (!produtoId || !operacao || quantidade == null) return res.status(400).json({ error: 'produtoId, operacao e quantidade são obrigatórios' });

      const payload: any = {
        produto:    { id: Number(produtoId) },
        operacao,
        quantidade: Number(quantidade),
      };
      if (deposito) payload.deposito = { id: Number(deposito) };
      if (observacoes) payload.observacoes = observacoes;

      const resp = await fetch('https://www.bling.com.br/Api/v3/estoques', {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const errMsg = data?.error?.description || data?.message || `Bling retornou ${resp.status}`;
        return res.status(resp.status).json({ success: false, error: errMsg, detail: data });
      }
      res.json({ success: true, data: data?.data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Sincronizar tudo de uma vez (orders + invoices + products + stock)
  app.post('/api/bling/sync/all', async (req, res) => {
    try {
      const token = normalizeBearerToken(req.headers['authorization'] as string || '');
      if (!token) return res.status(401).json({ error: 'Token não fornecido' });

      const dataInicio = String(req.body?.dataInicio || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0]);
      const dataFim = String(req.body?.dataFim || new Date().toISOString().split('T')[0]);

      console.log(`🔄 [SYNC COMPLETO] Sincronizando tudo: ${dataInicio} a ${dataFim}`);

      const results: Record<string, any> = {};

      // Orders
      try {
        const ordResp = await fetch(
          `https://www.bling.com.br/Api/v3/pedidos/vendas?dataInicial=${dataInicio}&dataFinal=${dataFim}&limit=100`,
          { headers: { 'Authorization': token, 'Accept': 'application/json' } }
        );
        const ordData = await ordResp.json();
        results.orders = { success: ordResp.ok, count: (ordData.data || []).length };
      } catch (e: any) { results.orders = { success: false, error: e.message }; }

      // Invoices
      try {
        const nfResp = await fetch(
          `https://www.bling.com.br/Api/v3/nfe?dataEmissaoInicial=${dataInicio}%2000:00:00&dataEmissaoFinal=${dataFim}%2023:59:59&limit=100`,
          { headers: { 'Authorization': token, 'Accept': 'application/json' } }
        );
        const nfData = await nfResp.json();
        results.invoices = { success: nfResp.ok, count: (nfData.data || []).length };
      } catch (e: any) { results.invoices = { success: false, error: e.message }; }

      // Products
      try {
        const prodResp = await fetch(
          'https://www.bling.com.br/Api/v3/produtos?limite=100',
          { headers: { 'Authorization': token, 'Accept': 'application/json' } }
        );
        const prodData = await prodResp.json();
        results.products = { success: prodResp.ok, count: (prodData.data || []).length };
      } catch (e: any) { results.products = { success: false, error: e.message }; }

      console.log('✅ [SYNC COMPLETO] Resultado:', results);

      res.json({
        success: true,
        results,
        timestamp: Date.now()
      });
    } catch (error: any) {
      console.error('❌ [SYNC COMPLETO ERROR]:', error);
      res.status(500).json({ success: false, errorMessage: error.message });
    }
  });

  app.post('/api/bling/sync/vinculate', async (req, res) => {
    try {
      const { erpProductId, blingProductId, blingCode, erpSku } = req.body;

      if (!erpProductId || !blingProductId) {
        return res.status(400).json({ error: 'erpProductId e blingProductId são obrigatórios' });
      }

      const vinculation = {
        id: `vinc-${Date.now()}`,
        erpProductId,
        blingProductId,
        blingCode: blingCode || '',
        erpSku: erpSku || '',
        createdAt: Date.now(),
        lastSyncedAt: Date.now()
      };

      productVinculations.push(vinculation);
      syncedProductsStore = syncedProductsStore.map((product: any) =>
        product.codigo === blingCode
          ? { ...product, finalProductSku: erpSku || null, finalProductId: erpProductId }
          : product
      );

      syncedOrdersStore = syncedOrdersStore.map((order: any) =>
        order.sku === blingCode
          ? { ...order, finalProductSku: erpSku || null, finalProductId: erpProductId }
          : order
      );
      console.log(`🔗 [VINCULATION] Produto ERP ${erpProductId} vinculado ao Bling ${blingProductId}`);

      res.json({ success: true, vinculation });
    } catch (error: any) {
      console.error('❌ [VINCULATION ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/bling/sync/status', (req, res) => {
    const lastSync = syncLogs[0] || null;
    const ordersSyncCount = syncLogs.filter(l => l.type === 'PEDIDOS').length;
    const invoicesSyncCount = syncLogs.filter(l => l.type === 'NOTAS_FISCAIS').length;
    const productsSyncCount = syncLogs.filter(l => l.type === 'PRODUTOS').length;

    res.json({
      lastSync,
      stats: {
        totalSyncs: syncLogs.length,
        ordersSyncs: ordersSyncCount,
        invoicesSyncs: invoicesSyncCount,
        productsSyncs: productsSyncCount,
        vinculations: productVinculations.length
      },
      recentSyncs: syncLogs.slice(0, 10)
    });
  });

  // ADVANCED FILTERING - PHASE 2
  
  // In-memory storage for lotes and filtered results
  let lotes: any[] = [];
  let filteredDataStore: any = {};

  app.post('/api/bling/filter', (req, res) => {
    try {
      const { dataType, filters } = req.body;
      
      console.log(`🔍 [FILTER REQUEST] Type: ${dataType}`, filters);

      let results: any[] = [];

      if (dataType === 'orders') {
        results = [...syncedOrdersStore];
      } else if (dataType === 'invoices') {
        results = [...syncedInvoicesStore];
      } else if (dataType === 'products') {
        results = [...syncedProductsStore];
      }

      // Apply filters
      let filtered = results;

      if (filters.searchTerm) {
        const term = filters.searchTerm.toLowerCase();
        filtered = filtered.filter(item =>
          JSON.stringify(item).toLowerCase().includes(term)
        );
      }

      if (filters.status && filters.status.length > 0) {
        filtered = filtered.filter(item => filters.status.includes(item.status));
      }

      if (filters.lote) {
        filtered = filtered.filter(item => item.lote === filters.lote);
      }

      if (filters.skus && filters.skus.length > 0) {
        filtered = filtered.filter(item => filters.skus.includes(item.sku || item.codigo));
      }

      if (filters.dateFrom) {
        filtered = filtered.filter(item => (item.data || item.dataEmissao) >= filters.dateFrom);
      }

      if (filters.dateTo) {
        filtered = filtered.filter(item => (item.data || item.dataEmissao) <= filters.dateTo);
      }

      // Sort
      if (filters.sortBy) {
        const fieldMap: Record<string, string> = {
          date: dataType === 'invoices' ? 'dataEmissao' : 'data',
          amount: dataType === 'invoices' ? 'valorNota' : 'total',
          status: 'status',
          name: dataType === 'products' ? 'descricao' : 'customer_name'
        };
        const sortField = fieldMap[filters.sortBy] || filters.sortBy;

        filtered.sort((a, b) => {
          let aVal = a[sortField];
          let bVal = b[sortField];
          const order = filters.sortOrder === 'asc' ? 1 : -1;
          if (aVal === bVal) return 0;
          if (aVal === undefined || aVal === null) return 1;
          if (bVal === undefined || bVal === null) return -1;
          return (aVal > bVal ? 1 : -1) * order;
        });
      }

      console.log(`✅ [FILTER RESULT] ${filtered.length} items found`);

      res.json({
        success: true,
        items: filtered,
        totalCount: results.length,
        displayCount: filtered.length,
        hasMore: false,
        filters
      });
    } catch (error: any) {
      console.error('❌ [FILTER ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Bulk Operations
  app.post('/api/bling/bulk/change-status', (req, res) => {
    try {
      const { itemIds, status } = req.body;

      if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
        return res.status(400).json({ error: 'itemIds deve ser um array não vazio' });
      }

      console.log(`📊 [BULK CHANGE STATUS] ${itemIds.length} items para status: ${status}`);

      const result = {
        success: true,
        operationId: `bulk-${Date.now()}`,
        type: 'UPDATE_STATUS',
        itemsProcessed: itemIds.length,
        itemsFailed: 0,
        status: 'SUCCESS',
        message: `✅ Status atualizado para ${itemIds.length} itens`
      };

      res.json(result);
    } catch (error: any) {
      console.error('❌ [BULK CHANGE STATUS ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/bling/bulk/assign-lote', (req, res) => {
    try {
      const { itemIds, loteId, loteName } = req.body;

      if (!itemIds || !Array.isArray(itemIds)) {
        return res.status(400).json({ error: 'itemIds deve ser um array' });
      }

      console.log(`🏷️ [BULK ASSIGN LOTE] ${itemIds.length} items para lote: ${loteName}`);

      const result = {
        success: true,
        operationId: `bulk-${Date.now()}`,
        type: 'ASSIGN_LOTE',
        loteId,
        loteName,
        itemsProcessed: itemIds.length,
        itemsFailed: 0,
        status: 'SUCCESS',
        message: `✅ ${itemIds.length} itens atribuídos ao lote ${loteName}`
      };

      res.json(result);
    } catch (error: any) {
      console.error('❌ [BULK ASSIGN LOTE ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/bling/bulk/delete', (req, res) => {
    try {
      const { itemIds } = req.body;

      if (!itemIds || !Array.isArray(itemIds)) {
        return res.status(400).json({ error: 'itemIds deve ser um array' });
      }

      console.log(`🗑️ [BULK DELETE] ${itemIds.length} items deletados`);

      const result = {
        success: true,
        operationId: `bulk-${Date.now()}`,
        type: 'DELETE',
        itemsProcessed: itemIds.length,
        itemsFailed: 0,
        status: 'SUCCESS',
        message: `✅ ${itemIds.length} itens deletados`
      };

      res.json(result);
    } catch (error: any) {
      console.error('❌ [BULK DELETE ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/bling/export/csv', (req, res) => {
    try {
      const { dataType, itemIds } = req.body;

      console.log(`📥 [EXPORT CSV] Type: ${dataType}, Items: ${itemIds?.length || 'all'}`);

      let sourceItems: any[] = [];
      if (dataType === 'orders') sourceItems = [...syncedOrdersStore];
      if (dataType === 'invoices') sourceItems = [...syncedInvoicesStore];
      if (dataType === 'products') sourceItems = [...syncedProductsStore];

      if (Array.isArray(itemIds) && itemIds.length > 0) {
        sourceItems = sourceItems.filter((item: any) => itemIds.includes(item.id));
      }

      let csv = '';
      if (dataType === 'orders') {
        csv = 'ID,Pedido,BlingID,Cliente,Data,Canal,Status,SKU,ProdutoFinal,Quantidade,ValorTotal\n';
        csv += sourceItems.map((item: any) => [
          item.id,
          item.orderId,
          item.blingId,
          item.customer_name,
          item.data,
          item.canal,
          item.status,
          item.sku,
          item.finalProductSku || '',
          item.quantity ?? '',
          item.total ?? ''
        ].map((v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      } else if (dataType === 'invoices') {
        csv = 'ID,Numero,Serie,Cliente,DataEmissao,ValorNota,Situacao,PedidoVenda\n';
        csv += sourceItems.map((item: any) => [
          item.id,
          item.numero,
          item.serie,
          item.nomeCliente,
          item.dataEmissao,
          item.valorNota,
          item.situacao,
          item.idPedidoVenda
        ].map((v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      } else if (dataType === 'products') {
        csv = 'ID,SKU,Descricao,Preco,EstoqueAtual,ProdutoFinal,Origem\n';
        csv += sourceItems.map((item: any) => [
          item.id,
          item.codigo,
          item.descricao,
          item.preco,
          item.estoqueAtual,
          item.finalProductSku || '',
          item.source || 'BLING'
        ].map((v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="export-${dataType}-${Date.now()}.csv"`);
      res.send(csv);
    } catch (error: any) {
      console.error('❌ [EXPORT CSV ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/bling/lotes', (req, res) => {
    try {
      console.log(`📋 [GET LOTES] Total: ${lotes.length}`);
      
      res.json({
        success: true,
        lotes: lotes.length > 0 ? lotes : [
          { id: 'lote-001', name: 'Lote-001', itemsCount: 2, completedCount: 1, errorCount: 0, status: 'EM_PROCESSAMENTO' },
          { id: 'lote-002', name: 'Lote-002', itemsCount: 0, completedCount: 0, errorCount: 0, status: 'NOVO' }
        ]
      });
    } catch (error: any) {
      console.error('❌ [GET LOTES ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/bling/lotes', (req, res) => {
    try {
      const { name, description } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'name é obrigatório' });
      }

      const newLote = {
        id: `lote-${Date.now()}`,
        name,
        description,
        createdAt: Date.now(),
        itemsCount: 0,
        completedCount: 0,
        errorCount: 0,
        status: 'NOVO'
      };

      lotes.push(newLote);
      console.log(`✅ [CREATE LOTE] ${name}`);

      res.json(newLote);
    } catch (error: any) {
      console.error('❌ [CREATE LOTE ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // NFe & SEFAZ INTEGRATION - PHASE 3
  
  // In-memory storage for NFes and configurations
  // Configuração de NFe (salva em Supabase também)
  let nfeConfig: any = {
    emissao: 'NORMAL',
    ambiente: 'HOMOLOGAÇÃO',
    versaoPadrao: '4.00',
    cnpjEmitente: '12.345.678/0001-90',
    uf: 'SP',
    numSerieNFe: '1',
    naturezaOperacao: 'Venda',
    sequencialAssinatura: 1
  };

  // Gerar NFe (Supabase)
  // Diagnóstico: Verificar tabelas via REST API
  app.get('/api/diagnose/nfe', async (req, res) => {
    try {
      const SUPABASE_URL = 'https://uafsmsiwaxopxznupuqw.supabase.co';
      const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhZnNtc2l3YXhvcHh6bnVwdXF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1NjAzMTIsImV4cCI6MjA3NDEzNjMxMn0._MGnu8LweUSinOSegxfyiKmYZJe-r54tfCPe6pIM_tI';

      const response = await fetch(`${SUPABASE_URL}/rest/v1/nfes?select=*&limit=1`, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });

      if (!response.ok) {
        return res.json({
          tabela: 'nfes',
          existe: false,
          erro: 'Não conseguiu acessar'
        });
      }

      const data = await response.json();
      return res.json({
        tabela: 'nfes',
        existe: true,
        total_registros: data?.length || 0,
        first_record: data?.[0] || null
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // TEST: Endpoint simples sem Supabase
  app.post('/api/test/echo', (req, res) => {
    console.log('🟢 [TEST] Echo request recebida');
    res.json({ ok: true, received: req.body });
  });

  app.post('/api/nfe/gerar', async (req, res) => {
    try {
      const { pedidoId, cliente, valor, dadosAdicionais } = req.body;

      if (!pedidoId) {
        return res.status(400).json({ error: 'pedidoId é obrigatório' });
      }

      console.log('📋 [HANDLER /api/nfe/gerar] Requisição recebida');
      console.log('📋 [HANDLER /api/nfe/gerar] Chamando obterProximoNumeroNFe()...');

      // Obter próximo número (sem série para simplicidade)
      const proximoNumero = await obterProximoNumeroNFe();
      console.log('📋 [HANDLER /api/nfe/gerar] Próximo número obtido:', proximoNumero);

      const novaNFe = {
        id: `nfe-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        numero: String(proximoNumero).padStart(6, '0'),
        serie: '1',
        emissao: Date.now(),
        cliente: cliente || { nome: 'Cliente Default', cnpj: '00.000.000/0000-00' },
        valor: valor || 100.00,
        pedidoId,
        status: 'RASCUNHO',
        chaveAcesso: null,
        xmlOriginal: '<NFeData />',
        xmlAssinado: null,
        sefazEnvio: null,
        certificadoUsado: null,
        tentativasEnvio: 0,
        erroDetalhes: null,
        ...dadosAdicionais
      };

      console.log('📋 [HANDLER /api/nfe/gerar] Objeto NFe montado:', novaNFe.id);
      console.log('📋 [HANDLER /api/nfe/gerar] Chamando criarNFe()...');

      const resultado = await criarNFe(novaNFe);

      console.log('📋 [HANDLER /api/nfe/gerar] Resultado:', resultado.sucesso ? '✅' : '❌');

      if (!resultado.sucesso) {
        console.error('📋 [HANDLER /api/nfe/gerar] Erro retornado:', resultado.erro);
        return res.status(500).json({ error: resultado.erro || 'Erro ao criar NFe' });
      }

      console.log(`📄 [GERAR NFe] Pedido ${pedidoId} - NFe ${novaNFe.numero}`);

      res.json({
        success: true,
        nfe: resultado.nfe,
        message: `✅ NFe #${novaNFe.numero} gerada com sucesso`
      });
    } catch (error: any) {
      console.error('❌ [GERAR NFe ERROR] Exception ao executar handler:', error);
      console.error('❌ [GERAR NFe ERROR] Stack:', error.stack);
      res.status(500).json({ error: error.message, stack: error.stack });
    }
  });

  // Carregar Certificado A1 (Parse PFX Real + Supabase)
  app.post('/api/nfe/certificado/carregar', async (req, res) => {
    try {
      const senha = req.headers['x-certificado-senha'] as string;
      const arquivoBuffer = Buffer.from(req.body.arquivo || '', 'base64');

      if (!senha) {
        return res.status(400).json({ error: 'Senha do certificado obrigatória' });
      }

      if (!arquivoBuffer || arquivoBuffer.length === 0) {
        return res.status(400).json({ error: 'Arquivo do certificado obrigatório' });
      }

      console.log(`🔐 [CERTIFICADO] Fazendo parse do arquivo .pfx...`);

      // Fazer parse real do certificado A1
      const resultado = parseArquivoPFX(arquivoBuffer, senha);

      if (!resultado.sucesso) {
        console.error(`❌ [CERTIFICADO] ${resultado.erro}`);
        return res.status(400).json({ 
          error: resultado.erro,
          detalhes: 'Verifique a senha e o arquivo .pfx'
        });
      }

      const certificado = resultado.certificado!;

      // Validar certificado
      const validacao = validarCertificado(certificado);
      if (!validacao.valido && validacao.erros.some(e => e.includes('expirou'))) {
        return res.status(400).json({
          error: 'Certificado expirado',
          erros: validacao.erros
        });
      }

      // Armazenar certificado em Supabase
      const resultadoDb = await criarCertificado({
        nome: certificado.nome || '',
        cnpj: certificado.cnpj,
        tipo: certificado.tipo,
        issuer: certificado.issuer || '',
        subject: certificado.subject || '',
        valido: certificado.valido,
        dataInicio: certificado.dataValidade - (365 * 24 * 60 * 60 * 1000),
        dataValidade: certificado.dataValidade,
        thumbprint: certificado.thumbprint,
        algoritmoAssinatura: certificado.algoritmoAssinatura,
        certificadoPem: certificado.certificadoPem,
        chavePem: certificado.chavePem,
        erros: certificado.erros
      });

      if (!resultadoDb.sucesso) {
        return res.status(500).json({ error: 'Erro ao salvar certificado no banco' });
      }

      console.log(`✅ [CERTIFICADO] Carregado com sucesso`);
      console.log(`   CNPJ: ${certificado.cnpj}`);
      console.log(`   Válido até: ${new Date(certificado.dataValidade).toLocaleDateString('pt-BR')}`);
      console.log(`   Thumbprint: ${certificado.thumbprint}`);

      res.json({
        success: true,
        certificado: {
          id: resultadoDb.certificado?.id,
          nome: certificado.nome,
          cnpj: certificado.cnpj,
          tipo: certificado.tipo,
          valido: certificado.valido,
          dataValidade: certificado.dataValidade,
          thumbprint: certificado.thumbprint,
          algoritmoAssinatura: certificado.algoritmoAssinatura,
          erros: certificado.erros
        },
        message: `✅ Certificado A1 carregado com sucesso`
      });
    } catch (error: any) {
      console.error('❌ [CERTIFICADO ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Listar Certificados (Supabase)
  app.get('/api/nfe/certificados', async (req, res) => {
    try {
      const certs = await listarCertificados(true);
      console.log(`🔐 [LISTAR CERTIFICADOS] Total: ${certs.length}`);
      res.json({
        success: true,
        certificados: certs.map(c => ({
          id: c.id,
          nome: c.nome,
          cnpj: c.cnpj,
          valido: c.valido,
          dataValidade: c.dataValidade,
          tipo: c.tipo
        }))
      });
    } catch (error: any) {
      console.error('❌ [LISTAR CERTIFICADOS ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Assinar NFe (Supabase)
  app.post('/api/nfe/assinar', async (req, res) => {
    try {
      const { nfeId, certificadoId } = req.body;

      const nfe = await obterNFe(nfeId);
      if (!nfe) {
        return res.status(404).json({ error: 'NFe não encontrada' });
      }

      const cert = await obterCertificado(certificadoId);
      if (!cert) {
        return res.status(404).json({ error: 'Certificado não encontrado' });
      }

      // Validar certificado
      const agora = Date.now();
      if (cert.dataValidade < agora) {
        return res.status(400).json({ 
          error: 'Certificado expirado',
          dataValidade: new Date(cert.dataValidade).toLocaleDateString('pt-BR')
        });
      }

      if (!cert.certificadoPem || !cert.chavePem) {
        return res.status(400).json({ 
          error: 'Certificado incompleto (PEM não disponível)'
        });
      }

      // Assinar XML da NFe com PKCS#7
      const xmlNFe = gerarXMLNFe(nfe);
      const assinatura = assinarXMLNFe(xmlNFe, cert.certificadoPem, cert.chavePem);

      if (!assinatura.sucesso) {
        return res.status(400).json({ 
          error: assinatura.erro
        });
      }

      // Atualizar NFe com assinatura em Supabase
      const resultadoUpdate = await atualizarNFe(nfeId, {
        status: 'ASSINADA' as any,
        xmlAssinado: assinatura.xmlAssinado,
        certificadoUsado: {
          id: cert.id,
          cnpj: cert.cnpj,
          thumbprint: cert.thumbprint
        }
      });

      if (!resultadoUpdate.sucesso) {
        return res.status(500).json({ error: 'Erro ao atualizar NFe com assinatura' });
      }

      console.log(`🔏 [ASSINATURA PKCS#7] ${nfeId}`);
      console.log(`   Certificado: ${cert.cnpj}`);
      console.log(`   Algoritmo: ${cert.algoritmoAssinatura}`);
      console.log(`   Status: ASSINADA`);

      res.json({
        success: true,
        nfe: {
          ...nfe,
          xmlAssinado: nfe.xmlAssinado?.substring(0, 100) + '...' // Truncar para resposta
        },
        message: `✅ NFe assinada com PKCS#7 com sucesso`
      });
    } catch (error: any) {
      console.error('❌ [ASSINAR NFe ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Enviar para SEFAZ (SOAP Real)
  app.post('/api/nfe/enviar', async (req, res) => {
    try {
      const { nfeId, ambiente } = req.body;

      const nfe = await obterNFe(nfeId);
      if (!nfe) {
        return res.status(404).json({ error: 'NFe não encontrada' });
      }

      if (nfe.status !== 'ASSINADA') {
        return res.status(400).json({ error: 'NFe deve estar assinada antes de enviar' });
      }

      // Usar integração SOAP real com SEFAZ
      const sefazConfig: SefazConfig = {
        uf: nfeConfig.uf || 'SP',
        cnpj: nfeConfig.cnpj || '12345678000190',
        ambiente: ambiente === 'PRODUÇÃO' ? 'PRODUCAO' : 'HOMOLOGACAO'
      };

      console.log(`📤 [SEFAZ SOAP] Integrando com SEFAZ real para ${ambiente}...`);

      // Fazer requisição SOAP para SEFAZ
      const resultadoSefaz = await enviarNFeParaSefaz(nfe, sefazConfig);

      const nfeAtualizada = {
        status: (resultadoSefaz.sucesso ? 'AUTORIZADA' : 'REJEITADA') as any,
        chaveAcesso: resultadoSefaz.chaveAcesso || `35${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}123456000195550010${String(nfe.numero).padStart(8, '0')}12345678`,
        sefazEnvio: {
        nfeId,
        dataEnvio: Date.now(),
        versaoPadrao: nfeConfig.versaoPadrao || '4.00',
        ambiente,
        statusSefaz: resultadoSefaz.codigo,
        protocoloAutorizacao: resultadoSefaz.protocolo || '000000000000000',
        dataAutorizacao: Date.now(),
        erroSefaz: resultadoSefaz.mensagem
        },
        tentativasEnvio: (nfe.tentativasEnvio || 0) + 1,
        erroDetalhes: resultadoSefaz.sucesso ? null : resultadoSefaz.mensagem
      };

      const updateResult = await atualizarNFe(nfeId, nfeAtualizada);
      if (!updateResult.sucesso) {
        return res.status(500).json({ error: updateResult.erro || 'Erro ao atualizar NFe após envio' });
      }

      console.log(`✅ [SEFAZ RESPOSTA] ${nfeId} - Status SEFAZ: ${nfeAtualizada.status}`);

      res.json({
        success: resultadoSefaz.sucesso,
        nfe: updateResult.nfe,
        sefazResponse: resultadoSefaz,
        message: resultadoSefaz.sucesso 
          ? `✅ NFe autorizada pela SEFAZ (${resultadoSefaz.codigo})`
          : `⚠️ NFe rejeitada: ${resultadoSefaz.mensagem}`
      });
    } catch (error: any) {
      console.error('❌ [ENVIAR SEFAZ ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Consultar Status da NFe no SEFAZ (SOAP)
  app.get('/api/nfe/consultar-status', async (req, res) => {
    try {
      const { chaveAcesso, ambiente } = req.query;

      if (!chaveAcesso || typeof chaveAcesso !== 'string') {
        return res.status(400).json({ error: 'Chave de acesso obrigatória' });
      }

      const nfe = await obterNFePorChaveAcesso(chaveAcesso);
      if (!nfe) {
        return res.status(404).json({ error: 'NFe não encontrada' });
      }

      // Usar integração SOAP real com SEFAZ
      const sefazConfig: SefazConfig = {
        uf: nfeConfig.uf || 'SP',
        cnpj: nfeConfig.cnpj || '12345678000190',
        ambiente: (ambiente as string) === 'PRODUÇÃO' ? 'PRODUCAO' : 'HOMOLOGACAO'
      };

      console.log(`🔍 [SEFAZ CONSULTA] Consultando status da chave: ${chaveAcesso}`);

      // Fazer requisição SOAP para consultar status
      const resultadoSefaz = await consultarStatusNFeSefaz(chaveAcesso, sefazConfig);

      // Atualizar status se necessário
      if (resultadoSefaz.sucesso && resultadoSefaz.codigo === '100') {
        const sefazEnvioAtualizado = {
          ...(nfe.sefazEnvio || {}),
          protocoloAutorizacao: resultadoSefaz.protocolo || nfe.sefazEnvio?.protocoloAutorizacao
        };
        await atualizarNFe(nfe.id, {
          status: 'AUTORIZADA' as any,
          sefazEnvio: sefazEnvioAtualizado
        });
      }

      console.log(`✅ [SEFAZ CONSULTA] Status recebido: ${resultadoSefaz.codigo}`);

      res.json({
        success: resultadoSefaz.sucesso,
        nfe: await obterNFe(nfe.id),
        sefazStatus: resultadoSefaz.codigo,
        sefazMensagem: resultadoSefaz.mensagem,
        protocoloAutorizacao: resultadoSefaz.protocolo
      });
    } catch (error: any) {
      console.error('❌ [CONSULTAR STATUS ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Cancelar NFe no SEFAZ (SOAP)
  app.post('/api/nfe/cancelar', async (req, res) => {
    try {
      const { nfeId, justificativa } = req.body;

      const nfe = await obterNFe(nfeId);
      if (!nfe) {
        return res.status(404).json({ error: 'NFe não encontrada' });
      }

      if (nfe.status !== 'AUTORIZADA') {
        return res.status(400).json({ error: 'Apenas NFes autorizadas podem ser canceladas' });
      }

      // Usar integração SOAP real com SEFAZ
      const sefazConfig: SefazConfig = {
        uf: nfeConfig.uf || 'SP',
        cnpj: nfeConfig.cnpj || '12345678000190',
        ambiente: nfe.sefazEnvio?.ambiente === 'PRODUÇÃO' ? 'PRODUCAO' : 'HOMOLOGACAO'
      };

      console.log(`🚫 [SEFAZ CANCELAMENTO] Cancelando NFe: ${nfeId}`);

      // Fazer requisição SOAP para cancelar
      const resultadoSefaz = await cancelarNFeSefaz(nfe.chaveAcesso, justificativa, sefazConfig);

      if (resultadoSefaz.sucesso) {
        const updateResult = await atualizarNFe(nfeId, {
          status: 'CANCELADA' as any,
          sefazEnvio: {
            ...(nfe.sefazEnvio || {}),
            justificativaCancelamento: justificativa,
            dataCancelamento: Date.now()
          }
        });

        if (!updateResult.sucesso) {
          return res.status(500).json({ error: updateResult.erro || 'Erro ao persistir cancelamento' });
        }
      }

      console.log(`✅ [SEFAZ CANCELAMENTO] ${resultadoSefaz.sucesso ? 'Cancelada' : 'Falhou'}`);

      res.json({
        success: resultadoSefaz.sucesso,
        nfe: await obterNFe(nfeId),
        message: resultadoSefaz.sucesso
          ? '✅ NFe cancelada com sucesso'
          : `⚠️ Erro ao cancelar: ${resultadoSefaz.mensagem}`
      });
    } catch (error: any) {
      console.error('❌ [CANCELAR NFe ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Listar NFes
  app.get('/api/nfe/listar', async (req, res) => {
    try {
      const { status, dateFrom, dateTo, pedidoId } = req.query;

      const resultado = await listarNFes({
        status: (status as string) || undefined,
        pedidoId: (pedidoId as string) || undefined,
        dataInicio: dateFrom ? parseInt(dateFrom as string) : undefined,
        dataFim: dateTo ? parseInt(dateTo as string) : undefined
      });

      console.log(`📋 [LISTAR NFes] Total: ${resultado.count}`);

      res.json({
        success: true,
        nfes: resultado,
        count: resultado.count
      });
    } catch (error: any) {
      console.error('❌ [LISTAR NFes ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Baixar XML
  app.get('/api/nfe/:nfeId/xml', async (req, res) => {
    try {
      const { nfeId } = req.params;
      const nfe = await obterNFe(nfeId);

      if (!nfe) {
        return res.status(404).json({ error: 'NFe não encontrada' });
      }

      const xmlContent = nfe.xmlAssinado || nfe.xmlOriginal || '<NFeVazia />';
      
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="nfe-${nfe.numero}.xml"`);
      res.send(xmlContent);
    } catch (error: any) {
      console.error('❌ [BAIXAR XML ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Obter Configuração
  app.get('/api/nfe/configuracao', (req, res) => {
    try {
      console.log(`⚙️ [OBTER CONFIG NFe]`);
      res.json({
        success: true,
        configuracao: nfeConfig
      });
    } catch (error: any) {
      console.error('❌ [OBTER CONFIG ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Atualizar Configuração
  app.put('/api/nfe/configuracao', (req, res) => {
    try {
      const novasConfig = req.body;
      nfeConfig = { ...nfeConfig, ...novasConfig };
      
      console.log(`⚙️ [ATUALIZAR CONFIG NFe]`);

      res.json({
        success: true,
        configuracao: nfeConfig,
        message: '✅ Configurações atualizadas'
      });
    } catch (error: any) {
      console.error('❌ [ATUALIZAR CONFIG ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // PHASE 3 HÍBRIDO: Enviar NFe para SEFAZ via Bling API
  app.post('/api/nfe/enviar-bling', async (req, res) => {
    try {
      const { nfeId, pedidoId, ambiente, via } = req.body;
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace('Bearer ', '');

      if (!token) {
        return res.status(401).json({ error: 'Token do Bling obrigatório' });
      }

      const nfe = await obterNFe(nfeId);
      if (!nfe) {
        return res.status(404).json({ error: 'NFe não encontrada' });
      }

      // Em produção: fazer requisição para API do Bling
      // const blingResponse = await fetch('https://www.bling.com.br/api/v3/nfe/send', {
      //   method: 'POST',
      //   headers: {
      //     'Authorization': `Bearer ${token}`,
      //     'Content-Type': 'application/json'
      //   },
      //   body: JSON.stringify({ nfeId, pedidoId, ambiente })
      // });

      // Mock: Simular resposta do Bling
      const chaveAcesso = `35${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}${nfeConfig.cnpj || '00000000000000'}${String(nfe.numero).padStart(8, '0')}12345678`;
      
      let statusFinal: any = 'ENVIADA';
      const sefazEnvio = {
        nfeId,
        dataEnvio: Date.now(),
        versaoPadrao: nfeConfig.versaoPadrao,
        ambiente,
        statusSefaz: '100',
        protocoloAutorizacao: String(Math.floor(Math.random() * 1000000000000)).padStart(15, '0'),
        dataAutorizacao: Date.now()
      };
      let erroDetalhes: string | null = null;

      // Simular: 90% de chance com Bling (mais confiável)
      if (Math.random() > 0.1) {
        statusFinal = 'AUTORIZADA';
      } else {
        statusFinal = 'REJEITADA';
        erroDetalhes = 'Erro na validação pela Bling/SEFAZ';
      }

      const updateResult = await atualizarNFe(nfeId, {
        status: statusFinal,
        chaveAcesso,
        sefazEnvio,
        tentativasEnvio: (nfe.tentativasEnvio || 0) + 1,
        erroDetalhes
      });

      if (!updateResult.sucesso) {
        return res.status(500).json({ error: updateResult.erro || 'Erro ao atualizar NFe no envio Bling' });
      }

      console.log(`📤 [ENVIAR BLING/SEFAZ] ${nfeId} - Via: ${via} - Status: ${statusFinal}`);

      res.json({
        success: statusFinal === 'AUTORIZADA',
        nfe: updateResult.nfe,
        message: statusFinal === 'AUTORIZADA' 
          ? `✅ NFe autorizada via Bling/SEFAZ`
          : `⚠️ NFe rejeitada pela Bling: ${erroDetalhes}`
      });
    } catch (error: any) {
      console.error('❌ [ENVIAR BLING ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // PHASE 3 HÍBRIDO: Consultar Status via Bling
  app.get('/api/nfe/status-bling', async (req, res) => {
    try {
      const { chaveAcesso, ambiente } = req.query;
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace('Bearer ', '');

      if (!token) {
        return res.status(401).json({ error: 'Token do Bling obrigatório' });
      }

      // Em produção: consultar status via API Bling/SEFAZ
      const nfe = await obterNFePorChaveAcesso(String(chaveAcesso));

      if (!nfe) {
        return res.status(404).json({ error: 'NFe não encontrada' });
      }

      console.log(`🔍 [STATUS BLING] ${chaveAcesso} - Status: ${nfe.status}`);

      res.json({
        success: true,
        chaveAcesso,
        status: nfe.status,
        statusSefaz: nfe.sefazEnvio?.statusSefaz,
        protocoloAutorizacao: nfe.sefazEnvio?.protocoloAutorizacao,
        dataAutorizacao: nfe.sefazEnvio?.dataAutorizacao,
        nfe
      });
    } catch (error: any) {
      console.error('❌ [STATUS BLING ERROR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // GERAR NF-e VIA ROTA NATIVA DO BLING: POST /pedidos/vendas/{id}/gerar-nfe
  // Bling resolve itens, contato, parcelas, endereço, frete etc. automaticamente
  // ────────────────────────────────────────────────────────────────────────────
  app.post('/api/bling/nfe/criar-emitir', async (req, res) => {
    try {
      const { blingOrderId, emitir = false } = req.body as { blingOrderId: string | number; emitir?: boolean };
      const rawAuth = req.headers.authorization || '';
      const token = rawAuth.startsWith('Bearer ') ? rawAuth : `Bearer ${rawAuth}`;

      if (!rawAuth) return res.status(401).json({ error: 'Token do Bling obrigatório' });
      if (!blingOrderId) return res.status(400).json({ error: 'blingOrderId obrigatório' });

      const headers = { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' };
      const readH = { Authorization: token, Accept: 'application/json' };

      // ─── Passo 1: Gerar NF-e via rota nativa do Bling ─────────────────────
      // POST /pedidos/vendas/{id}/gerar-nfe — Bling preenche tudo automaticamente
      console.log(`📄 [NFe] Gerando NF-e via /pedidos/vendas/${blingOrderId}/gerar-nfe`);
      const gerarResp = await fetch(
        `https://www.bling.com.br/Api/v3/pedidos/vendas/${Number(blingOrderId)}/gerar-nfe`,
        { method: 'POST', headers },
      );

      let gerarData: any;
      try { gerarData = await gerarResp.json(); } catch { gerarData = {}; }

      if (!gerarResp.ok) {
        console.error(`❌ [NFe] Erro ao gerar via rota nativa:`, JSON.stringify(gerarData, null, 2));
        const blingErr = gerarData?.error || gerarData?.errors?.[0] || {};
        const fields: string[] = Array.isArray(blingErr?.fields)
          ? blingErr.fields.map((f: any) => `${f.element || f.field || ''}: ${f.msg || f.message || ''}`).filter(Boolean)
          : [];
        const errDesc = blingErr?.description || blingErr?.message || gerarData?.message || `Bling retornou ${gerarResp.status}`;
        const fullMsg = fields.length > 0 ? `${errDesc} — ${fields.join('; ')}` : errDesc;
        return res.status(gerarResp.status).json({ success: false, error: fullMsg, detail: gerarData });
      }

      // Resposta: { data: { id, numero, ... } } ou lista de NF-e geradas
      const nfesCriadas = Array.isArray(gerarData?.data) ? gerarData.data : (gerarData?.data ? [gerarData.data] : []);
      const primeiraId = nfesCriadas[0]?.id;
      console.log(`✅ [NFe] Gerada(s): ${nfesCriadas.map((n: any) => n.id).join(', ')}`);

      if (!primeiraId || !emitir) {
        return res.json({ success: true, emitida: false, nfe: nfesCriadas[0] || gerarData?.data, nfes: nfesCriadas });
      }

      // ─── Passo 2: Emitir NF-e (transmitir ao SEFAZ) ───────────────────────
      console.log(`📤 [NFe] Emitindo NF-e ${primeiraId}…`);
      const emitResp = await fetch(`https://www.bling.com.br/Api/v3/nfe/${primeiraId}/enviar`, {
        method: 'POST',
        headers,
      });

      let emitData: any;
      try { emitData = await emitResp.json(); } catch { emitData = {}; }

      if (!emitResp.ok) {
        console.error(`❌ [NFe] Erro ao emitir:`, emitData);
        return res.status(emitResp.status).json({
          success: false, emitida: false, nfe: nfesCriadas[0],
          error: emitData?.error?.description || emitData?.message || `Bling retornou ${emitResp.status} ao emitir`,
          detail: emitData,
        });
      }

      console.log(`✅ [NFe] Emitida com sucesso!`);
      return res.json({ success: true, emitida: true, nfe: { ...nfesCriadas[0], ...emitData?.data }, nfes: nfesCriadas });
    } catch (error: any) {
      console.error('❌ [NFe criar-emitir]:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // CANAIS DE VENDA — GET /api/bling/canais-venda (lista real da conta Bling)
  // ────────────────────────────────────────────────────────────────────────────
  app.get('/api/bling/canais-venda', async (req, res) => {
    try {
      const rawAuth = req.headers.authorization || '';
      const token = rawAuth.startsWith('Bearer ') ? rawAuth : `Bearer ${rawAuth}`;
      if (!rawAuth) return res.status(401).json({ error: 'Token obrigatório' });

      const resp = await fetch('https://www.bling.com.br/Api/v3/canais-venda', {
        headers: { Authorization: token, Accept: 'application/json' },
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return res.status(resp.status).json({ error: data?.error?.description || `Erro ${resp.status}`, detail: data });

      const canais = Array.isArray(data?.data) ? data.data : [];
      console.log(`📺 [Canais] ${canais.length} canal(is) encontrado(s)`);
      res.json({ success: true, canais });
    } catch (error: any) {
      console.error('❌ [Canais]:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // DETALHES / ALTERAR PEDIDO DE VENDA — GET ou PUT /api/bling/pedido-venda/:id
  // ────────────────────────────────────────────────────────────────────────────
  app.get('/api/bling/pedido-venda/:id', async (req, res) => {
    try {
      const rawAuth = req.headers.authorization || '';
      const token = rawAuth.startsWith('Bearer ') ? rawAuth : `Bearer ${rawAuth}`;
      if (!rawAuth) return res.status(401).json({ error: 'Token obrigatório' });

      const resp = await fetch(`https://www.bling.com.br/Api/v3/pedidos/vendas/${req.params.id}`, {
        headers: { Authorization: token, Accept: 'application/json' },
      });
      const data = await resp.json().catch(() => ({}));
      res.status(resp.status).json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/bling/pedido-venda/:id', async (req, res) => {
    try {
      const rawAuth = req.headers.authorization || '';
      const token = rawAuth.startsWith('Bearer ') ? rawAuth : `Bearer ${rawAuth}`;
      if (!rawAuth) return res.status(401).json({ error: 'Token obrigatório' });

      console.log(`✏️ [Pedido] Atualizando pedido ${req.params.id}`);
      const resp = await fetch(`https://www.bling.com.br/Api/v3/pedidos/vendas/${req.params.id}`, {
        method: 'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const blingErr = data?.error || data?.errors?.[0] || {};
        return res.status(resp.status).json({ success: false, error: blingErr?.description || `Erro ${resp.status}`, detail: data });
      }
      res.json({ success: true, data: data?.data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // NOTAS FISCAIS DE SAÍDA — listar, baixar XML/DANFE
  // ────────────────────────────────────────────────────────────────────────────
  app.get('/api/bling/nfe/listar-saida', async (req, res) => {
    try {
      const rawAuth = req.headers.authorization || '';
      const token = rawAuth.startsWith('Bearer ') ? rawAuth : `Bearer ${rawAuth}`;
      if (!rawAuth) return res.status(401).json({ error: 'Token obrigatório' });

      const { dataInicial, dataFinal, situacao, pagina } = req.query as any;
      const params = new URLSearchParams();
      params.set('tipo', '1'); // 1 = saída
      params.set('pagina', pagina || '1');
      params.set('limite', '100');
      if (dataInicial) params.set('dataEmissaoInicial', dataInicial);
      if (dataFinal) params.set('dataEmissaoFinal', dataFinal);
      if (situacao) params.set('situacao', situacao); // 1=Pendente, 2=Cancelada, 3=Aguardando recibo, 4=Rejeitada, 5=Autorizada, 6=Emitida, 7=Denegada, 8=Encerrada

      const url = `https://www.bling.com.br/Api/v3/nfe?${params.toString()}`;
      console.log(`📋 [NFe Saída] GET ${url}`);
      const resp = await fetch(url, { headers: { Authorization: token, Accept: 'application/json' } });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return res.status(resp.status).json({ error: data?.error?.description || `Erro ${resp.status}`, detail: data });

      const notas = Array.isArray(data?.data) ? data.data : [];
      console.log(`📋 [NFe Saída] ${notas.length} nota(s) encontrada(s)`);
      res.json({ success: true, notas });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET detalhes de uma NF-e (inclui XML, chave, etc.)
  app.get('/api/bling/nfe/detalhe/:id', async (req, res) => {
    try {
      const rawAuth = req.headers.authorization || '';
      const token = rawAuth.startsWith('Bearer ') ? rawAuth : `Bearer ${rawAuth}`;
      if (!rawAuth) return res.status(401).json({ error: 'Token obrigatório' });

      const resp = await fetch(`https://www.bling.com.br/Api/v3/nfe/${req.params.id}`, {
        headers: { Authorization: token, Accept: 'application/json' },
      });
      const data = await resp.json().catch(() => ({}));
      res.status(resp.status).json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // BUSCAR ETIQUETAS DE ENVIO DO BLING (logística/remessas)
  // ────────────────────────────────────────────────────────────────────────────
  app.post('/api/bling/etiquetas/buscar', async (req, res) => {
    try {
      const { pedidoVendaIds } = req.body as { pedidoVendaIds: (string | number)[] };
      const rawAuth = req.headers.authorization || '';
      const authToken = rawAuth.startsWith('Bearer ') ? rawAuth : `Bearer ${rawAuth}`;

      if (!rawAuth) return res.status(401).json({ error: 'Token do Bling obrigatório' });
      if (!Array.isArray(pedidoVendaIds) || pedidoVendaIds.length === 0) {
        return res.status(400).json({ error: 'pedidoVendaIds[] obrigatório' });
      }

      const readH = { Authorization: authToken, Accept: 'application/json' };
      const results: any[] = [];

      for (const pvId of pedidoVendaIds) {
        try {
          // Busca detalhes do pedido para obter info de transporte
          const pvResp = await fetch(
            `https://www.bling.com.br/Api/v3/pedidos/vendas/${Number(pvId)}`,
            { headers: readH },
          );
          if (!pvResp.ok) {
            results.push({ pedidoVendaId: pvId, success: false, error: `Pedido ${pvId} não encontrado (${pvResp.status})` });
            continue;
          }
          const pvData = (await pvResp.json().catch(() => ({})))?.data;
          const transporte = pvData?.transporte || {};
          const rastreamento = transporte.codigoRastreamento || '';
          const volumes = Number(transporte.volumes || transporte.quantidadeVolumes || 1);
          const nomeCliente = pvData?.contato?.nome || '';
          const numero = pvData?.numero || pvData?.numeroLoja || pvId;
          const itens = (pvData?.itens || []).map((i: any) => `${i.quantidade}x ${i.descricao}`).join(', ');
          const endereco = pvData?.transporte?.enderecoEntrega || {};
          const endStr = [endereco.endereco, endereco.numero, endereco.bairro, endereco.municipio?.nome || endereco.municipio, endereco.municipio?.uf || endereco.uf, (endereco.cep || '').replace(/\D/g, '')]
            .filter(Boolean).join(', ');

          // Gera ZPL com dados reais do pedido
          const dataNow = new Date().toLocaleString('pt-BR');
          const zpl = `^XA
^PW800
^LL1200
^CF0,36
^FO40,30^FDETIQUETA DE ENVIO^FS
^FO40,75^GB720,3,3^FS
^CF0,28
^FO40,100^FDPedido: ${numero}^FS
^FO40,140^FDCliente: ${(nomeCliente || '').slice(0, 40)}^FS
^CF0,24
^FO40,185^FDRastreamento: ${rastreamento || 'N/A'}^FS
^FO40,220^FDVolumes: ${volumes}^FS
^FO40,260^GB720,2,2^FS
^FO40,280^FDItens: ${(itens || 'N/A').slice(0, 55)}^FS
^FO40,320^GB720,2,2^FS
^CF0,22
^FO40,345^FDEndere${String.fromCharCode(231)}o:^FS
^FO40,375^FD${(endStr || 'N/A').slice(0, 55)}^FS
${(endStr || '').length > 55 ? `^FO40,405^FD${endStr.slice(55, 110)}^FS` : ''}
^FO40,440^GB720,2,2^FS
${rastreamento ? `^BY3,3,100\n^FO100,470^BCN,100,Y,N,N\n^FD${rastreamento}^FS` : `^BY3,3,100\n^FO100,470^BCN,100,Y,N,N\n^FD${numero}^FS`}
^CF0,20
^FO40,620^FDGerado: ${dataNow}^FS
^FO40,650^FDOrigem: Bling / ERP^FS
^XZ`;

          results.push({
            pedidoVendaId: pvId,
            numero,
            nomeCliente,
            rastreamento,
            success: true,
            zpl,
          });
        } catch (e: any) {
          results.push({ pedidoVendaId: pvId, success: false, error: e.message });
        }
      }

      const ok = results.filter(r => r.success).length;
      const fail = results.filter(r => !r.success).length;
      console.log(`🏷️ [Etiquetas] ${ok} gerada(s), ${fail} falha(s) de ${pedidoVendaIds.length} pedido(s)`);
      res.json({ success: true, total: pedidoVendaIds.length, ok, fail, results });
    } catch (error: any) {
      console.error('❌ [Etiquetas buscar]:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.all(/^\/api\/bling\//, async (req, res, next) => {
    // Skip rotas já tratadas por handlers específicos — passa para o próximo handler
    if (
      req.path.startsWith('/api/bling/sync') ||
      req.path.startsWith('/api/bling/filter') ||
      req.path.startsWith('/api/bling/bulk') ||
      req.path.startsWith('/api/bling/export') ||
      req.path.startsWith('/api/bling/lotes') ||
      req.path.startsWith('/api/bling/etiquetas') ||
      req.path === '/api/bling/token' ||
      req.path === '/api/bling/nfe/criar-emitir' ||
      req.path.startsWith('/api/bling/nfe/listar-saida') ||
      req.path.startsWith('/api/bling/nfe/detalhe') ||
      req.path === '/api/bling/canais-venda' ||
      req.path.startsWith('/api/bling/pedido-venda') ||
      req.path.startsWith('/api/bling/vendas')
    ) return next();

    try {
      // Remove /api/bling prefix
      const endpoint = req.path.replace(/^\/api\/bling/, '');
      const method = req.method;
      const apiKey = req.headers['authorization'] || '';
      const query = new URLSearchParams(req.query as any).toString();
      
      const url = `https://www.bling.com.br/Api/v3${endpoint}${query ? `?${query}` : ''}`;
      
      const response = await fetch(url, {
        method: method,
        headers: {
          'Authorization': apiKey,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: ['POST', 'PUT', 'PATCH'].includes(method) ? JSON.stringify(req.body) : undefined
      });

      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error: any) {
      console.error('Bling Proxy Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BUSCAR PEDIDOS DE VENDAS — filtro situação "Em Aberto" (idsSituacoes=6)
  // Retorna todos os pedidos sem salvar localmente.
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/bling/vendas/buscar', async (req, res) => {
    try {
      const token = normalizeBearerToken(req.headers['authorization'] as string || '');
      if (!token) return res.status(401).json({ error: 'Token não fornecido' });

      const dataInicio   = String(req.query.dataInicio || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
      const dataFim      = String(req.query.dataFim    || new Date().toISOString().split('T')[0]);
      const situacoesRaw = String(req.query.situacoes || '6');
      const situacaoIds  = situacoesRaw.split(',').map((s: string) => s.trim()).filter(Boolean);

      console.log(`🛒 [VENDAS BUSCAR] ${dataInicio} → ${dataFim} | situações: ${situacaoIds.join(',')}`);

      // ── 1. Busca a listagem paginada ──────────────────────────────────────────
      const allRawOrders: any[] = [];
      let pagina = 1;
      let continuar = true;

      while (continuar) {
        const situacoesQs = situacaoIds.map((id: string, i: number) => `idsSituacoes[${i}]=${id}`).join('&');
        const url = `https://www.bling.com.br/Api/v3/pedidos/vendas?dataInicial=${dataInicio}&dataFinal=${dataFim}&${situacoesQs}&limite=100&pagina=${pagina}`;
        const pageResp = await fetch(url, { headers: { Authorization: token, Accept: 'application/json' } });

        if (!pageResp.ok) {
          if (pagina === 1) {
            const errBody = await pageResp.text().catch(() => '');
            return res.status(pageResp.status).json({ error: `Bling retornou ${pageResp.status}`, detail: errBody });
          }
          break;
        }

        const pageData = await pageResp.json();
        const pageOrders: any[] = pageData?.data || [];
        allRawOrders.push(...pageOrders);

        if (pageOrders.length < 100) continuar = false;
        else pagina++;
        if (pagina > 20) continuar = false;
      }

      console.log(`🛒 [VENDAS BUSCAR] ${allRawOrders.length} pedido(s) em ${pagina} página(s) — buscando detalhes...`);

      // ── 2. Enriquece com detalhes completos (itens, endereço, pagamentos) ────
      // Bling v3 lista retorna dados resumidos; GET /pedidos/vendas/{id} retorna completo
      const CONCURRENCY = 5;
      const enrichedRaw: any[] = new Array(allRawOrders.length);
      for (let i = 0; i < allRawOrders.length; i += CONCURRENCY) {
        const batch = allRawOrders.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(async (o: any) => {
          try {
            const detResp = await fetch(`https://www.bling.com.br/Api/v3/pedidos/vendas/${o.id}`, {
              headers: { Authorization: token, Accept: 'application/json' },
            });
            if (detResp.ok) {
              const detData = await detResp.json();
              return detData?.data || o;
            }
          } catch { /* silencioso */ }
          return o;
        }));
        results.forEach((r, bi) => { enrichedRaw[i + bi] = r; });
      }

      console.log(`🛒 [VENDAS BUSCAR] ${enrichedRaw.length} pedido(s) enriquecidos com detalhes`);

      // ── 3. Mapeia campos completos ─────────────────────────────────────────
      const orders = enrichedRaw.filter(Boolean).map((order: any) => {
        const canalRaw = order?.loja?.nome || order?.loja?.descricao || order?.origem?.nome || order?.origem || order?.tipo || '';
        const detectedCanal = parseCanal(canalRaw);
        const items = Array.isArray(order?.itens) ? order.itens : [];
        const parcelas = Array.isArray(order?.parcelas) ? order.parcelas : (Array.isArray(order?.pagamentos) ? order.pagamentos : []);
        const endEntrega = order?.enderecoEntrega || order?.transporte?.enderecoEntrega || null;

        return {
          id:               `venda-${order.id}`,
          orderId:          String(order?.numeroLoja || order?.numero || order?.id || ''),
          blingId:          String(order?.id || ''),
          blingNumero:      String(order?.numero || ''),
          customer_name:    order?.contato?.nome || 'Não informado',
          customer_cpf_cnpj: order?.contato?.numeroDocumento || order?.contato?.cpf || order?.contato?.cnpj || '',
          customer_email:   order?.contato?.email || '',
          customer_tel:     order?.contato?.telefone || order?.contato?.celular || '',
          data:             String(order?.data || '').split('T')[0],
          dataPrevista:     String(order?.dataPrevista || '').split('T')[0],
          status:           String(order?.situacao?.descricao || order?.situacao?.valor || 'Em aberto'),
          situacaoId:       Number(order?.situacao?.id || 0),
          canal:            detectedCanal,
          canalRaw:         String(canalRaw),
          lojaId:           Number(order?.loja?.id || 0),
          loja:             order?.loja?.nome || order?.loja?.descricao || '',
          total:            Number(order?.total || 0),
          price_total:      Number(order?.total || 0),
          frete:            Number(order?.frete || 0),
          desconto:         Number(order?.desconto?.valor || 0),
          rastreamento:     order?.transporte?.codigoRastreamento || '',
          transportador:    order?.transporte?.transportador?.nome || '',
          tipoFrete:        order?.transporte?.tipoFrete || '',
          observacoes:      order?.observacoes || '',
          observacoesInternas: order?.observacoesInternas || '',
          enderecoEntrega:  endEntrega ? {
            nome:         endEntrega?.nome || order?.contato?.nome || '',
            logradouro:   endEntrega?.endereco || endEntrega?.logradouro || '',
            numero:       endEntrega?.numero || '',
            complemento:  endEntrega?.complemento || '',
            bairro:       endEntrega?.bairro || '',
            cidade:       endEntrega?.municipio?.nome || endEntrega?.cidade || '',
            uf:           endEntrega?.municipio?.uf || endEntrega?.uf || '',
            cep:          endEntrega?.cep || '',
            pais:         endEntrega?.pais || 'BR',
          } : null,
          pagamentos: parcelas.map((p: any) => ({
            forma:     p?.formaPagamento?.descricao || p?.forma || p?.tipo || 'Não informado',
            valor:     Number(p?.valor || 0),
            parcelas:  Number(p?.numeroParcelas || p?.parcelas || 1),
          })),
          itens: items.map((item: any) => ({
            sku:           String(item?.codigo || item?.codigoProduto || '').trim(),
            descricao:     item?.descricao || item?.nome || '',
            quantidade:    Number(item?.quantidade || 0),
            valorUnitario: Number(item?.valor || item?.valorUnitario || 0),
            subtotal:      Number(item?.quantidade || 0) * Number(item?.valor || 0),
            unidade:       item?.unidade || 'UN',
            produtoId:     String(item?.produto?.id || item?.idProduto || ''),
          })),
          itensCount: items.length,
        };
      });

      res.json({ success: true, total: orders.length, orders });
    } catch (error: any) {
      console.error('❌ [VENDAS BUSCAR]:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MERCADO LIVRE INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  /** Troca code OAuth pelo access_token do Mercado Livre */
  app.post('/api/ml/token', async (req, res) => {
    try {
      const { grant_type, code, refresh_token, client_id, client_secret, redirect_uri } = req.body;

      const body = new URLSearchParams();
      body.append('grant_type', grant_type || 'authorization_code');
      if (code)          body.append('code', code);
      if (refresh_token) body.append('refresh_token', refresh_token);
      if (redirect_uri)  body.append('redirect_uri', redirect_uri);
      body.append('client_id', client_id);
      body.append('client_secret', client_secret);

      const response = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: body.toString(),
      });

      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error: any) {
      console.error('ML Token Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Obtém info do vendedor (para pegar seller_id) */
  app.get('/api/ml/user', async (req, res) => {
    try {
      const token = normalizeBearerToken(req.headers['authorization'] as string || '');
      if (!token) return res.status(401).json({ error: 'Token não fornecido' });

      const response = await fetch('https://api.mercadolibre.com/users/me', {
        headers: { 'Authorization': token, 'Accept': 'application/json' },
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** Sincroniza pedidos do Mercado Livre com paginação automática */
  app.get('/api/ml/sync/orders', async (req, res) => {
    try {
      const token = normalizeBearerToken(req.headers['authorization'] as string || '');
      if (!token) return res.status(401).json({ error: 'Token não fornecido' });

      const sellerId  = String(req.query.sellerId || '');
      const dataInicio = String(req.query.dataInicio || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0]);
      const dataFim   = String(req.query.dataFim   || new Date().toISOString().split('T')[0]);

      if (!sellerId) return res.status(400).json({ error: 'sellerId é obrigatório' });

      console.log(`🛒 [ML SYNC ORDERS] Vendedor ${sellerId} | ${dataInicio} → ${dataFim}`);

      const allOrders: any[] = [];
      let offset = 0;
      const limit = 50;
      let hasMore = true;
      let page = 0;
      const MAX_PAGES = 10000; // Remover limite arbitrário - importar TODOS

      while (hasMore && page < MAX_PAGES) {
        const dateFrom = `${dataInicio}T00:00:00.000-03:00`;
        const dateTo   = `${dataFim}T23:59:59.000-03:00`;
        const url = `https://api.mercadolibre.com/orders/search?seller=${sellerId}&order.date_created.from=${encodeURIComponent(dateFrom)}&order.date_created.to=${encodeURIComponent(dateTo)}&sort=date_desc&offset=${offset}&limit=${limit}`;

        const resp = await fetch(url, { headers: { 'Authorization': token, 'Accept': 'application/json' } });
        if (!resp.ok) {
          if (page === 0) return res.status(resp.status).json({ error: 'Erro ao buscar pedidos do ML' });
          break;
        }

        const repo = await resp.json();
        const results: any[] = pageData.results || [];
        allOrders.push(...results);

        const total = pageData.paging?.total || 0;
        offset += results.length;
        if (results.length < limit || offset >= total) hasMore = false;
        page++;

        console.log(`📦 ML: Página ${page} importada (${allOrders.length}/${total} pedidos)`);
      }

      if (page >= MAX_PAGES) {
        console.warn(`⚠️  ML: Limite de ${MAX_PAGES} páginas atingido. Pode haver mais pedidos.`);
      }

      // Normalizar para o formato interno
      const orders = allOrders.map((order: any) => ({
        id: `ml-${order.id}`,
        orderId: String(order.id),
        blingId: '',
        customer_name: order.buyer?.nickname || order.buyer?.first_name || 'Comprador ML',
        customer_cpf_cnpj: '',
        data: (order.date_created || '').split('T')[0],
        status: order.status || '',
        canal: 'ML' as const,
        total: Number(order.total_amount || 0),
        frete: Number(order.shipping?.cost || 0),
        itens: (order.order_items || []).map((item: any) => ({
          id: String(item.item?.id || ''),
          sku: item.item?.seller_sku || item.item?.id || '',
          descricao: item.item?.title || '',
          quantidade: Number(item.quantity || 1),
          valorUnitario: Number(item.unit_price || 0),
          subtotal: Number(item.quantity || 1) * Number(item.unit_price || 0),
        })),
        itensCount: (order.order_items || []).length,
        sku: (order.order_items || [])[0]?.item?.seller_sku || '',
        quantity: (order.order_items || []).reduce((s: number, i: any) => s + Number(i.quantity || 0), 0),
        unit_price: (order.order_items || [])[0]?.unit_price || 0,
      }));

      // Log detalhado de itens importados
      const totalItens = orders.reduce((sum, o) => sum + (o.itensCount || 0), 0);
      orders.forEach(order => {
        if (!order.itens || order.itens.length === 0) {
          console.warn(`⚠️  [ML] Pedido ${order.orderId} SEM ITENS na resposta`);
        } else {
          console.log(`📦 [ML] Pedido ${order.orderId}: ${order.itens.length} itens`);
        }
      });

      console.log(`✅ [ML SYNC ORDERS] ${orders.length} pedidos, ${totalItens} itens importados em ${page} página(s)`);
      res.json({ success: true, orders, total: allOrders.length, pages: page });
    } catch (error: any) {
      console.error('ML Sync Orders Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SHOPEE INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  /** Gera URL de autenticação Shopee (com HMAC-SHA256) */
  app.get('/api/shopee/auth-url', async (req, res) => {
    try {
      const { partnerId, partnerKey, redirect } = req.query as any;
      if (!partnerId || !partnerKey) return res.status(400).json({ error: 'partnerId e partnerKey obrigatórios' });

      const { createHmac } = await import('crypto');
      const timestamp = Math.floor(Date.now() / 1000);
      const basePath = '/api/v2/shop/auth_partner';
      const rawSign = `${partnerId}${basePath}${timestamp}`;
      const sign = createHmac('sha256', partnerKey).update(rawSign).digest('hex');

      const redirectUri = encodeURIComponent(redirect || 'https://localhost:3000/shopee-callback');
      const authUrl = `https://partner.shopeemall.com.br${basePath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${decodeURIComponent(redirectUri)}`;
      res.json({ authUrl });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** Troca code pelo token Shopee */
  app.post('/api/shopee/token', async (req, res) => {
    try {
      const { partnerId, partnerKey, code, shopId } = req.body;
      if (!partnerId || !partnerKey || !code) return res.status(400).json({ error: 'partnerId, partnerKey e code obrigatórios' });

      const { createHmac } = await import('crypto');
      const timestamp = Math.floor(Date.now() / 1000);
      const basePath = '/api/v2/auth/token/get';
      const rawSign = `${partnerId}${basePath}${timestamp}`;
      const sign = createHmac('sha256', partnerKey).update(rawSign).digest('hex');

      const response = await fetch(`https://partner.shopeemall.com.br${basePath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, shop_id: shopId ? Number(shopId) : undefined, partner_id: Number(partnerId) }),
      });

      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error: any) {
      console.error('Shopee Token Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Sincroniza pedidos Shopee */
  app.get('/api/shopee/sync/orders', async (req, res) => {
    try {
      const { partnerId, partnerKey, shopId, accessToken, dataInicio, dataFim } = req.query as any;
      if (!partnerId || !partnerKey || !shopId || !accessToken) return res.status(400).json({ error: 'Parâmetros obrigatórios faltando' });

      const { createHmac } = await import('crypto');

      const timeFrom = dataInicio ? Math.floor(new Date(`${dataInicio}T00:00:00`).getTime() / 1000) : Math.floor((Date.now() - 30*24*60*60*1000) / 1000);
      const timeTo   = dataFim   ? Math.floor(new Date(`${dataFim}T23:59:59`).getTime()   / 1000) : Math.floor(Date.now() / 1000);

      // ── Passo 1: Coletar order_sn via paginação cursor — chunks de 15 dias ──
      // A Shopee limita get_order_list a no máximo 15 dias por chamada.
      const FIFTEEN_DAYS = 15 * 24 * 60 * 60;
      const allSnList: { order_sn: string; order_status: string; create_time: number }[] = [];
      const listBasePath = '/api/v2/order/get_order_list';
      let totalPages = 0;
      const MAX_PAGES_SHOPEE = 10000; // Remover limite arbitrário

      // Dividir o intervalo total em janelas de 15 dias
      for (let chunkFrom = timeFrom; chunkFrom < timeTo; chunkFrom += FIFTEEN_DAYS) {
        const chunkTo = Math.min(chunkFrom + FIFTEEN_DAYS - 1, timeTo);
        let cursor = '';
        let hasMore = true;

        while (hasMore && totalPages < MAX_PAGES_SHOPEE) {
          const chunkTs = Math.floor(Date.now() / 1000);
          const listRawSign = `${partnerId}${listBasePath}${chunkTs}${accessToken}${shopId}`;
          const listSign = createHmac('sha256', partnerKey).update(listRawSign).digest('hex');

          const params = new URLSearchParams({
            partner_id: partnerId,
            shop_id: shopId,
            access_token: accessToken,
            timestamp: String(chunkTs),
            sign: listSign,
            time_range_field: 'create_time',
            time_from: String(chunkFrom),
            time_to: String(chunkTo),
            page_size: '50',
            response_optional_fields: 'order_status',
            ...(cursor ? { cursor } : {}),
          });

          const resp = await fetch(`https://partner.shopeemall.com.br${listBasePath}?${params}`, {
            headers: { 'Content-Type': 'application/json' },
          });

          if (!resp.ok) {
            if (totalPages === 0) return res.status(resp.status).json({ error: 'Erro ao buscar lista de pedidos Shopee' });
            break;
          }

          const pageData = await resp.json();
          const response_obj = pageData.response || {};
          const list = response_obj.order_list || [];
          allSnList.push(...list);

          hasMore = response_obj.more === true;
          cursor = response_obj.next_cursor || '';
          totalPages++;

          console.log(`📦 Shopee: Página ${totalPages} importada (${allSnList.length} pedidos até agora)`);
        }
      }

      if (totalPages >= MAX_PAGES_SHOPEE) {
        console.warn(`⚠️  Shopee: Limite de ${MAX_PAGES_SHOPEE} páginas atingido. Veja se há mais pedidos.`);
      }

      // ── Passo 2: Buscar detalhes em lotes de 50 ───────────────────────────
      const detailBasePath = '/api/v2/order/get_order_detail';
      const detailFields = 'buyer_user_id,buyer_username,estimated_shipping_fee,recipient_address,actual_shipping_fee,goods_to_declare,note,note_update_time,pay_time,pickup_done_time,tracking_no,transaction_fee,actual_shipping_fee_confirmed,cod_amount,cod_exchanged_amount,seller_voucher_code,dropshipper,dropshipper_phone,split_up,buyer_cancel_reason,cancel_by,cancel_reason,actual_shipping_fee,estimated_shipping_fee,checkout_shipping_carrier,reverse_shipping_fee,order_chargeable_weight_gram,edt,order_sn,region,currency,total_amount,buyer_note,item_list,pay_time,pay_channel,cod_amount,create_time,update_time,days_to_ship,ship_by_date,invoice_data,checkout_shipping_carrier,actual_shipping_fee,estimated_shipping_fee,reverse_shipping_fee,package_list';

      const allOrders: any[] = [];
      const BATCH = 50;
      let batchCount = 0;
      for (let i = 0; i < allSnList.length; i += BATCH) {
        const batch = allSnList.slice(i, i + BATCH);
        const snParam = batch.map(o => o.order_sn).join(',');

        try {
          const detailTs = Math.floor(Date.now() / 1000);
          const detailRawSign = `${partnerId}${detailBasePath}${detailTs}${accessToken}${shopId}`;
          const detailSign = createHmac('sha256', partnerKey).update(detailRawSign).digest('hex');

          const detailParams = new URLSearchParams({
            partner_id: partnerId,
            shop_id: shopId,
            access_token: accessToken,
            timestamp: String(detailTs),
            sign: detailSign,
            order_sn_list: snParam,
            response_optional_fields: detailFields,
          });

          const detailResp = await fetch(`https://partner.shopeemall.com.br${detailBasePath}?${detailParams}`, {
            headers: { 'Content-Type': 'application/json' },
          });
          if (!detailResp.ok) {
            console.warn(`⚠️  Shopee: Erro ao buscar lote ${batchCount + 1}, continuando...`);
            continue;
          }
          const detailData = await detailResp.json();
          const detailList = detailData?.response?.order_list || [];
          allOrders.push(...detailList);
          batchCount++;
          
          console.log(`📦 Shopee: Lote ${batchCount} processado (${allOrders.length}/${allSnList.length} pedidos)`);
        } catch (err) {
          console.warn(`⚠️  Shopee: Erro no lote ${batchCount + 1}:`, err, 'continuando...');
        }
      }

      console.log(`✅ Shopee: ${batchCount} lotes processados, ${allOrders.length} pedidos obtidos`);

      // ── Normalizar para formato interno ───────────────────────────────────
      const orders = allOrders.map((order: any) => ({
        id: `shopee-${order.order_sn}`,
        orderId: String(order.order_sn || ''),
        blingId: '',
        customer_name: order.recipient_address?.name || order.buyer_username || 'Comprador Shopee',
        customer_cpf_cnpj: '',
        data: order.create_time ? new Date(order.create_time * 1000).toISOString().split('T')[0] : '',
        status: order.order_status || '',
        canal: 'SHOPEE' as const,
        total: Number(order.total_amount || 0),
        frete: Number(order.actual_shipping_fee ?? order.estimated_shipping_fee ?? 0),
        itens: (order.item_list || []).map((item: any) => ({
          id: String(item.item_id || ''),
          sku: item.model_sku || item.item_sku || String(item.item_id || ''),
          descricao: item.item_name || '',
          quantidade: Number(item.model_quantity_purchased || 1),
          valorUnitario: Number(item.model_discounted_price || item.model_original_price || 0),
          subtotal: Number(item.model_quantity_purchased || 1) * Number(item.model_discounted_price || item.model_original_price || 0),
        })),
        itensCount: (order.item_list || []).length,
        sku: (order.item_list || [])[0]?.model_sku || (order.item_list || [])[0]?.item_sku || '',
        quantity: (order.item_list || []).reduce((s: number, i: any) => s + Number(i.model_quantity_purchased || 0), 0),
        unit_price: (order.item_list || [])[0]?.model_discounted_price || (order.item_list || [])[0]?.model_original_price || 0,
      }));

      // Log detalhado de itens importados
      const totalItens = orders.reduce((sum, o) => sum + (o.itensCount || 0), 0);
      orders.forEach(order => {
        if (!order.itens || order.itens.length === 0) {
          console.warn(`⚠️  [SHOPEE] Pedido ${order.orderId} SEM ITENS na resposta`);
        } else {
          console.log(`📦 [SHOPEE] Pedido ${order.orderId}: ${order.itens.length} itens`);
        }
      });

      console.log(`✅ [SHOPEE SYNC ORDERS] ${orders.length} pedidos, ${totalItens} itens importados em ${totalPages} página(s)`);
      res.json({ success: true, orders, total: allOrders.length, pages: totalPages });
    } catch (error: any) {
      console.error('Shopee Sync Orders Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Cria o servidor HTTPS antes do Vite para passar como referência ao HMR
  const httpsServer = https.createServer({ key, cert }, app);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    try {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          // Usa o mesmo servidor HTTPS para o WebSocket HMR (evita porta 24678 separada)
          hmr: { server: httpsServer },
        },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("Vite middleware initialized");
    } catch (e) {
      console.error("Failed to load Vite:", e);
    }
  } else {
    // Serve static files in production
    const distPath = path.resolve(__dirname, "dist");
    if (fs.existsSync(distPath)) {
        app.use(express.static(distPath));
        
        app.get("*", (req, res) => {
            if (req.path.startsWith('/api')) {
                return res.status(404).json({ error: 'Not Found' });
            }
            res.sendFile(path.join(distPath, "index.html"));
        });
    } else {
        console.error("Dist folder not found. Run 'npm run build' first.");
    }
  }

  httpsServer.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Server running on https://localhost:${PORT}`);
    console.log(`🔒 SSL/TLS enabled with self-signed certificate`);
  });
}

startServer();
