
// lib/blingApi.ts
import { OrderItem, BlingInvoice, BlingProduct } from '../types';
import { getMultiplicadorFromSku, classificarCor } from './sku';

// Status do Pedido no Bling v3 (IDs):
// 6 = Em aberto, 9 = Atendido, 15 = Em andamento, 12 = Cancelado
const BLING_V3_STATUS_MAP: { [key: string]: number } = {
    'EM ABERTO': 6,
    'EM ANDAMENTO': 15,
    'ATENDIDO': 9,
    'TODOS': 0,
};

// Situação da Nota Fiscal no Bling v3 (IDs):
// 1 = Pendente, 6 = Emitida
const BLING_V3_INVOICE_STATUS_MAP: { [key: string]: number } = {
    'PENDENTES': 1,
    'EMITIDAS': 6,
};

// Use local proxy via Vite
const PROXY_URL = '/api/bling'; 

function cleanMoney(value: string | number): number {
    if (typeof value === 'number') return value;
    const num = parseFloat(String(value));
    return isNaN(num) ? 0 : num;
}

function formatDateFromBling(dateStr: string): string {
    if (!dateStr) return new Date().toISOString().split('T')[0];
    return dateStr.split(' ')[0];
}

function handleBlingError(data: any, defaultMessage: string): void {
    if (data.error && typeof data.error === 'string') {
         throw new Error(`Bling API: ${data.error} ${data.error_description ? `(${data.error_description})` : ''}`);
    }
    if (data.error) {
        const msg = data.error.description || data.error.message || JSON.stringify(data.error);
        throw new Error(`Bling API Error: ${msg}`);
    }
    if (data.type === 'error') {
         throw new Error(`Bling API Error: ${data.message} (${data.description})`);
    }
}

// Helper for V3 fetch with Auth header
async function fetchV3(endpoint: string, apiKey: string, params: Record<string, string> = {}) {
    let cleanKey = apiKey ? apiKey.trim() : '';
    if (!cleanKey.toLowerCase().startsWith('bearer ')) {
        cleanKey = `Bearer ${cleanKey}`;
    }

    const url = new URL(`${window.location.origin}${PROXY_URL}${endpoint}`);
    Object.keys(params).forEach(key => {
        if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
            url.searchParams.append(key, params[key]);
        }
    });

    const response = await fetch(url.toString(), {
        headers: {
            'Authorization': cleanKey,
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        const text = await response.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            throw new Error(`Erro na requisição Bling v3 (${response.status}): ${text}`);
        }
        
        // Verifica erro de token expirado
        if (json.error === "The access token provided is invalid" || json.error === "invalid_token" || response.status === 401) {
             throw new Error("TOKEN_EXPIRED"); // Erro especial para o frontend capturar
        }

        handleBlingError(json, `Erro ${response.status}`);
        return json;
    }

    return response.json();
}

/**
 * Troca o código de autorização pelo Access Token e Refresh Token.
 * OBRIGATÓRIO: redirect_uri deve ser idêntico ao usado na autorização.
 */
export async function executeBlingTokenExchange(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<any> {
    // Call our custom server endpoint which handles the form-urlencoded conversion and auth headers
    const response = await fetch('/api/bling/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code: code.trim(),
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri
        })
    });

    if (!response.ok) {
        const text = await response.text();
        let json;
        try { json = JSON.parse(text); } catch { throw new Error(`Erro ao trocar token: ${text}`); }
        handleBlingError(json, 'Falha na autenticação OAuth');
        return json;
    }

    return response.json();
}

/**
 * Renova o Access Token usando o Refresh Token.
 */
export async function executeTokenRefresh(refreshToken: string, clientId: string, clientSecret: string): Promise<any> {
    const response = await fetch('/api/bling/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao renovar token: ${text}`);
    }

    return response.json();
}


export async function fetchBlingOrders(
    apiKey: string, 
    filters: { startDate: string, endDate: string, status: 'EM ABERTO' | 'EM ANDAMENTO' | 'ATENDIDO' | 'TODOS' }
): Promise<OrderItem[]> {
    const detectCanal = (blingOrder: any): 'ML' | 'SHOPEE' | 'SITE' => {
        const sourceText = String(
            blingOrder?.loja?.nome ||
            blingOrder?.origem ||
            blingOrder?.tipo ||
            ''
        ).toUpperCase();

        if (sourceText.includes('MERCADO') || sourceText.includes('ML')) return 'ML';
        if (sourceText.includes('SHOPEE')) return 'SHOPEE';
        return 'SITE';
    };

    const idSituacao = BLING_V3_STATUS_MAP[filters.status];
    
    const params: any = {
        dataInicial: filters.startDate,
        dataFinal: filters.endDate,
        limit: '100',
    };

    if (idSituacao > 0) {
        params.idsSituacoes = [idSituacao];
    }

    const data = await fetchV3('/pedidos/vendas', apiKey, params);

    if (!data.data) return [];

    const allOrders: OrderItem[] = [];
    
    for (const blingOrder of data.data) {
        const externalId = blingOrder.numeroLoja ? String(blingOrder.numeroLoja).trim() : '';
        const internalId = String(blingOrder.numero);
        const orderId = externalId || internalId;

        if (!blingOrder.itens || blingOrder.itens.length === 0) continue;

        for (const item of blingOrder.itens) {
            const sku = String(item.codigo || '');
            const canal = detectCanal(blingOrder);
            allOrders.push({
                id: `${blingOrder.id}_${sku}`,
                orderId: orderId,
                blingId: String(blingOrder.id),
                tracking: blingOrder.transporte?.codigoRastreamento || '',
                sku,
                qty_original: cleanMoney(item.quantidade),
                multiplicador: getMultiplicadorFromSku(sku),
                qty_final: Math.round(cleanMoney(item.quantidade) * getMultiplicadorFromSku(sku)),
                color: classificarCor(item.descricao || ''),
                canal,
                data: formatDateFromBling(blingOrder.data),
                status: 'NORMAL',
                customer_name: blingOrder.contato?.nome || 'Não informado',
                customer_cpf_cnpj: blingOrder.contato?.numeroDocumento || '',
                price_gross: cleanMoney(item.valor),
                price_total: cleanMoney(blingOrder.total),
                platform_fees: 0,
                shipping_fee: cleanMoney(blingOrder.transporte?.frete || 0),
                shipping_paid_by_customer: cleanMoney(blingOrder.transporte?.frete || 0),
                price_net: cleanMoney(item.valor),
            });
        }
    }
    return allOrders;
}

export async function fetchBlingInvoices(
    apiKey: string,
    filters: { startDate: string, endDate: string, status: 'PENDENTES' | 'EMITIDAS' }
): Promise<BlingInvoice[]> {
    const idSituacao = BLING_V3_INVOICE_STATUS_MAP[filters.status];
    
    const params: any = {
        dataEmissaoInicial: `${filters.startDate} 00:00:00`,
        dataEmissaoFinal: `${filters.endDate} 23:59:59`,
        tipo: 1, 
        limit: '100'
    };

    if (idSituacao) {
        params.situacao = idSituacao;
    }

    const data = await fetchV3('/nfe', apiKey, params);
    
    if (!data.data) return [];

    return data.data.map((nf: any): BlingInvoice => {
        return {
            id: String(nf.id),
            numero: String(nf.numero),
            serie: String(nf.serie),
            dataEmissao: formatDateFromBling(nf.dataEmissao),
            nomeCliente: nf.contato?.nome || 'Consumidor',
            valorNota: cleanMoney(nf.valorNota),
            situacao: String(nf.situacao),
            idPedidoVenda: '', 
            linkDanfe: nf.linkDanfe || nf.xml
        };
    });
}

export async function fetchEtiquetaZplForPedido(apiKey: string, idPedidoVenda: string): Promise<string> {
    const safePedido = String(idPedidoVenda || '').replace(/[^a-zA-Z0-9-]/g, '');
    if (!safePedido) {
        throw new Error('Pedido inválido para geração de etiqueta.');
    }

    // Chama endpoint server-side que busca dados reais do pedido no Bling
    try {
        const resp = await fetch('/api/bling/etiquetas/buscar', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ pedidoVendaIds: [safePedido] }),
        });
        const data = await resp.json();
        if (data?.results?.[0]?.success && data.results[0].zpl) {
            return data.results[0].zpl;
        }
        // Se falhou, usa fallback
        console.warn(`[fetchEtiquetaZpl] Falha ao buscar do Bling: ${data?.results?.[0]?.error || 'desconhecido'}`);
    } catch (e) {
        console.warn(`[fetchEtiquetaZpl] Erro de rede:`, e);
    }

    // Fallback: gera ZPL básica com dados mínimos
    const now = new Date();
    const timestamp = now.toLocaleString('pt-BR');
    return `^XA
^PW800
^LL1200
^CF0,40
^FO40,30^FDETIQUETA - PEDIDO ${safePedido}^FS
^CF0,26
^FO40,90^FDGerada automaticamente (fallback)^FS
^FO40,130^FDOrigem: Bling / ERP^FS
^FO40,170^FDData: ${timestamp}^FS
^FO40,230^GB720,2,2^FS
^BY3,3,110
^FO80,280^BCN,120,Y,N,N
^FD${safePedido}^FS
^CF0,24
^FO40,450^FDPedido: ${safePedido}^FS
^FO40,490^FDFluxo: Pedidos -> Notas -> Etiquetas^FS
^FO40,530^FDStatus: Disponivel para processamento^FS
^FO40,570^FDSalve no historico apos processar^FS
^FO40,630^GB720,2,2^FS
^FO40,680^FDUso interno^FS
^XZ`;
}

/**
 * Busca etiquetas ZPL em lote para múltiplos pedidos de venda
 */
export async function fetchEtiquetasLote(apiKey: string, pedidoVendaIds: string[]): Promise<{
    total: number;
    ok: number;
    fail: number;
    results: Array<{ pedidoVendaId: string; success: boolean; zpl?: string; numero?: string; nomeCliente?: string; error?: string }>;
}> {
    const resp = await fetch('/api/bling/etiquetas/buscar', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ pedidoVendaIds }),
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err?.error || `Erro ${resp.status}`);
    }
    return resp.json();
}

export async function fetchBlingProducts(apiKey: string): Promise<BlingProduct[]> {
    const params = {
        limit: '100',
        criterio: '1', 
        tipo: 'P'
    };

    const data = await fetchV3('/produtos', apiKey, params);

    if (!data.data) return [];

    return data.data.map((prod: any): BlingProduct => {
        return {
            id: String(prod.id),
            codigo: prod.codigo,
            descricao: prod.nome,
            preco: cleanMoney(prod.preco),
            estoqueAtual: cleanMoney(prod.estoque?.saldoVirtual || 0),
        };
    });
}
// SYNC ENDPOINTS - PHASE 1
/**
 * Sincroniza Pedidos de Vendas do Bling
 */
export async function syncBlingOrders(
    token: string,
    dataInicio: string,
    dataFim: string,
    status: 'EM ABERTO' | 'EM ANDAMENTO' | 'ATENDIDO' | 'TODOS' = 'TODOS',
    canal: 'ML' | 'SHOPEE' | 'SITE' | 'ALL' = 'ALL'
): Promise<any> {
    const params = new URLSearchParams();
    if (dataInicio) params.append('dataInicio', dataInicio);
    if (dataFim) params.append('dataFim', dataFim);
    if (status) params.append('status', status);
    if (canal) params.append('canal', canal);

    const response = await fetch(`/api/bling/sync/orders?${params.toString()}`, {
        method: 'GET',
        headers: {
            'Authorization': token,
            'Accept': 'application/json'
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao sincronizar pedidos: ${text}`);
    }

    return response.json();
}

/**
 * Sincroniza Notas Fiscais do Bling
 */
export async function syncBlingInvoices(
    token: string,
    dataInicio: string,
    dataFim: string,
    status: 'PENDENTES' | 'EMITIDAS' | 'TODOS' = 'TODOS'
): Promise<any> {
    const params = new URLSearchParams();
    if (dataInicio) params.append('dataInicio', dataInicio);
    if (dataFim) params.append('dataFim', dataFim);
    if (status) params.append('status', status);

    const response = await fetch(`/api/bling/sync/invoices?${params.toString()}`, {
        method: 'GET',
        headers: {
            'Authorization': token,
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao sincronizar notas fiscais: ${text}`);
    }

    return response.json();
}

/**
 * Sincroniza Produtos do Bling
 */
export async function syncBlingProducts(token: string): Promise<any> {
    const response = await fetch('/api/bling/sync/products', {
        method: 'GET',
        headers: {
            'Authorization': token,
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao sincronizar produtos: ${text}`);
    }

    return response.json();
}

/**
 * Sincroniza Estoque do Bling (saldo real e virtual por SKU)
 */
export async function syncBlingStock(token: string): Promise<any> {
    const response = await fetch('/api/bling/sync/stock', {
        method: 'GET',
        headers: {
            'Authorization': token,
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao sincronizar estoque: ${text}`);
    }

    return response.json();
}

/**
 * Sincroniza tudo de uma vez: pedidos, notas, produtos e estoque
 */
export async function syncAllBling(
    token: string,
    params?: { dataInicio?: string; dataFim?: string }
): Promise<any> {
    const response = await fetch('/api/bling/sync/all', {
        method: 'POST',
        headers: {
            'Authorization': token,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            dataInicio: params?.dataInicio,
            dataFim: params?.dataFim
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao sincronizar tudo: ${text}`);
    }

    return response.json();
}

/**
 * Vincula um produto ERP com um produto do Bling
 */
export async function vinculateBlingProduct(
    erpProductId: string,
    blingProductId: string,
    blingCode: string,
    erpSku: string
): Promise<any> {
    const response = await fetch('/api/bling/sync/vinculate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            erpProductId,
            blingProductId,
            blingCode,
            erpSku
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao vincular produto: ${text}`);
    }

    return response.json();
}

/**
 * Obtém status da sincronização recente
 */
export async function getSyncStatus(): Promise<any> {
    const response = await fetch('/api/bling/sync/status', {
        headers: {
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error('Erro ao obter status de sincronização');
    }

    return response.json();
}

// ADVANCED FILTERING - PHASE 2
/**
 * Busca e filtra dados sincronizados com filtros avançados
 */
export async function searchAndFilter(
    dataType: 'orders' | 'invoices' | 'products',
    filters: {
        searchTerm?: string;
        status?: string[];
        dateFrom?: string;
        dateTo?: string;
        lote?: string;
        skus?: string[];
        sortBy?: 'date' | 'amount' | 'status' | 'name';
        sortOrder?: 'asc' | 'desc';
    }
): Promise<any> {
    const response = await fetch('/api/bling/filter', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            dataType,
            filters
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao filtrar dados: ${text}`);
    }

    return response.json();
}

/**
 * Realiza operação em lote: mudar status
 */
export async function bulkChangeStatus(
    itemIds: string[],
    newStatus: string
): Promise<any> {
    const response = await fetch('/api/bling/bulk/change-status', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            itemIds,
            status: newStatus
        })
    });

    if (!response.ok) {
        throw new Error('Erro ao mudar status em lote');
    }

    return response.json();
}

/**
 * Realiza operação em lote: atribuir lote
 */
export async function bulkAssignLote(
    itemIds: string[],
    loteId: string,
    loteName: string
): Promise<any> {
    const response = await fetch('/api/bling/bulk/assign-lote', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            itemIds,
            loteId,
            loteName
        })
    });

    if (!response.ok) {
        throw new Error('Erro ao atribuir lote');
    }

    return response.json();
}

/**
 * Realiza operação em lote: deletar itens
 */
export async function bulkDelete(itemIds: string[]): Promise<any> {
    const response = await fetch('/api/bling/bulk/delete', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({ itemIds })
    });

    if (!response.ok) {
        throw new Error('Erro ao deletar itens');
    }

    return response.json();
}

/**
 * Exporta itens para CSV
 */
export async function exportToCsv(
    dataType: 'orders' | 'invoices' | 'products',
    itemIds?: string[]
): Promise<Blob> {
    const response = await fetch('/api/bling/export/csv', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            dataType,
            itemIds
        })
    });

    if (!response.ok) {
        throw new Error('Erro ao exportar dados');
    }

    return response.blob();
}

/**
 * Obter lista de lotes
 */
export async function getLotes(): Promise<any[]> {
    const response = await fetch('/api/bling/lotes', {
        headers: {
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error('Erro ao obter lotes');
    }

    const data = await response.json();
    return data.lotes || [];
}

/**
 * Criar novo lote
 */
export async function createLote(
    name: string,
    description?: string
): Promise<any> {
    const response = await fetch('/api/bling/lotes', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            name,
            description
        })
    });

    if (!response.ok) {
        throw new Error('Erro ao criar lote');
    }

    return response.json();
}

// NFe & SEFAZ INTEGRATION - PHASE 3

/**
 * Gera uma NFe a partir de um pedido
 */
export async function gerarNFe(
    pedidoId: string,
    dadosAdicionais?: Partial<any>
): Promise<any> {
    const response = await fetch('/api/nfe/gerar', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            pedidoId,
            ...dadosAdicionais
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao gerar NFe: ${text}`);
    }

    return response.json();
}

/**
 * Carrega e armazena um certificado digital A1 (arquivo .pfx)
 */
export async function carregarCertificado(
    arquivoBuffer: ArrayBuffer,
    senha: string,
    cnpj: string
): Promise<any> {
    const response = await fetch('/api/nfe/certificado/carregar', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
            'X-Certificado-Senha': senha,
            'X-Certificado-CNPJ': cnpj
        },
        body: arquivoBuffer
    });

    if (!response.ok) {
        throw new Error('Erro ao carregar certificado');
    }

    return response.json();
}

/**
 * Lista certificados carregados
 */
export async function listarCertificados(): Promise<any[]> {
    const response = await fetch('/api/nfe/certificados', {
        headers: {
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error('Erro ao listar certificados');
    }

    const data = await response.json();
    return data.certificados || [];
}

/**
 * Assina uma NFe com o certificado digital
 */
export async function assinarNFe(
    nfeId: string,
    certificadoId: string
): Promise<any> {
    const response = await fetch('/api/nfe/assinar', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            nfeId,
            certificadoId
        })
    });

    if (!response.ok) {
        throw new Error('Erro ao assinar NFe');
    }

    return response.json();
}

/**
 * Envia NFe assinada para SEFAZ
 */
export async function enviarNFeSefaz(
    nfeId: string,
    ambiente: 'PRODUÇÃO' | 'HOMOLOGAÇÃO'
): Promise<any> {
    const response = await fetch('/api/nfe/enviar', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            nfeId,
            ambiente
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao enviar NFe para SEFAZ: ${text}`);
    }

    return response.json();
}

/**
 * Consulta status da NFe na SEFAZ
 */
export async function consultarStatusNFe(
    chaveAcesso: string,
    ambiente: 'PRODUÇÃO' | 'HOMOLOGAÇÃO'
): Promise<any> {
    const response = await fetch('/api/nfe/consultar', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            chaveAcesso,
            ambiente
        })
    });

    if (!response.ok) {
        throw new Error('Erro ao consultar status na SEFAZ');
    }

    return response.json();
}

/**
 * Obtém a lista de NFes geradas
 */
export async function listarNFes(
    filtros?: {
        status?: string;
        dateFrom?: string;
        dateTo?: string;
        pedidoId?: string;
    }
): Promise<any> {
    const params = new URLSearchParams();
    if (filtros?.status) params.append('status', filtros.status);
    if (filtros?.dateFrom) params.append('dateFrom', filtros.dateFrom);
    if (filtros?.dateTo) params.append('dateTo', filtros.dateTo);
    if (filtros?.pedidoId) params.append('pedidoId', filtros.pedidoId);

    const response = await fetch(`/api/nfe/listar?${params.toString()}`, {
        headers: {
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error('Erro ao listar NFes');
    }

    return response.json();
}

/**
 * Baixa XML de uma NFe
 */
export async function baixarXmlNFe(nfeId: string): Promise<Blob> {
    const response = await fetch(`/api/nfe/${nfeId}/xml`, {
        method: 'GET'
    });

    if (!response.ok) {
        throw new Error('Erro ao baixar XML');
    }

    return response.blob();
}

/**
 * Baixa PDF (DANFE) de uma NFe
 */
export async function baixarDanfePdf(nfeId: string): Promise<Blob> {
    const response = await fetch(`/api/nfe/${nfeId}/danfe-pdf`, {
        method: 'GET'
    });

    if (!response.ok) {
        throw new Error('Erro ao baixar DANFE PDF');
    }

    return response.blob();
}

/**
 * Cancela uma NFe autorizada
 */
export async function cancelarNFe(
    nfeId: string,
    justificativa: string
): Promise<any> {
    const response = await fetch('/api/nfe/cancelar', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            nfeId,
            justificativa
        })
    });

    if (!response.ok) {
        throw new Error('Erro ao cancelar NFe');
    }

    return response.json();
}

/**
 * Reenviar NFe não autorizada
 */
export async function reenviarNFe(
    nfeId: string,
    ambiente: 'PRODUÇÃO' | 'HOMOLOGAÇÃO'
): Promise<any> {
    const response = await fetch('/api/nfe/reenviar', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            nfeId,
            ambiente
        })
    });

    if (!response.ok) {
        throw new Error('Erro ao reenviar NFe');
    }

    return response.json();
}

/**
 * Obtém configuração atual de NFe
 */
export async function obterConfiguracaoNFe(): Promise<any> {
    const response = await fetch('/api/nfe/configuracao', {
        headers: {
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error('Erro ao obter configuração de NFe');
    }

    return response.json();
}

/**
 * Atualiza configuração de NFe
 */
export async function atualizarConfiguracaoNFe(
    config: Partial<any>
): Promise<any> {
    const response = await fetch('/api/nfe/configuracao', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify(config)
    });

    if (!response.ok) {
        throw new Error('Erro ao atualizar configuração');
    }

    return response.json();
}

/**
 * PHASE 3 X.509: Carregar certificado A1 com parse real
 */
export async function carregarCertificadoA1(
    arquivo: File,
    senha: string
): Promise<any> {
    try {
        // Converter arquivo para base64
        const arrayBuffer = await arquivo.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

        const response = await fetch('/api/nfe/certificado/carregar', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Certificado-Senha': senha
            },
            body: JSON.stringify({
                arquivo: base64,
                nomeArquivo: arquivo.name
            })
        });

        if (!response.ok) {
            const erro = await response.json();
            throw new Error(erro.error || 'Erro ao carregar certificado');
        }

        return response.json();
    } catch (error: any) {
        throw new Error(`Erro ao carregar certificado A1: ${error.message}`);
    }
}

/**
 * PHASE 3 X.509: Assinar NFe com certificado real
 */
export async function assinarNFeComCertificado(
    nfeId: string,
    certificadoId: string
): Promise<any> {
    const response = await fetch('/api/nfe/assinar', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            nfeId,
            certificadoId
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao assinar NFe: ${text}`);
    }

    return response.json();
}

/**
 * PHASE 3 HÍBRIDO: Enviar NFe para SEFAZ via Bling API
 */
export async function enviarNFeparaSefazViaBling(
    nfeId: string,
    pedidoId: string,
    ambiente: 'PRODUÇÃO' | 'HOMOLOGAÇÃO',
    token: string
): Promise<any> {
    const response = await fetch('/api/nfe/enviar-bling', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            nfeId,
            pedidoId,
            ambiente,
            via: 'bling'
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao enviar NFe via Bling: ${text}`);
    }

    return response.json();
}

/**
 * PHASE 3 HÍBRIDO: Consultar status NFe via Bling
 */
export async function consultarStatusNFeSefazViaBling(
    chaveAcesso: string,
    ambiente: 'PRODUÇÃO' | 'HOMOLOGAÇÃO',
    token: string
): Promise<any> {
    const response = await fetch(`/api/nfe/status-bling?chaveAcesso=${chaveAcesso}&ambiente=${ambiente}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    });

    if (!response.ok) {
        throw new Error('Erro ao consultar status via Bling');
    }

    return response.json();
}

/**
 * PHASE 3 HÍBRIDO: Escolher estratégia de envio (Bling ou Direto)
 */
export async function enviarNFeSefazHibrido(
    nfeId: string,
    pedidoId: string,
    ambiente: 'PRODUÇÃO' | 'HOMOLOGAÇÃO',
    estrategia: 'bling' | 'direto',
    token?: string
): Promise<any> {
    if (estrategia === 'bling' && !token) {
        throw new Error('Token do Bling é obrigatório para envio via Bling');
    }

    if (estrategia === 'bling') {
        return enviarNFeparaSefazViaBling(nfeId, pedidoId, ambiente, token!);
    } else {
        return enviarNFeParaSefazReal(nfeId, ambiente);
    }
}

/**
 * PHASE 3 SOAP REAL: Enviar para SEFAZ com integração SOAP real
 */
export async function enviarNFeParaSefazReal(
    nfeId: string,
    ambiente: 'PRODUÇÃO' | 'HOMOLOGAÇÃO'
): Promise<any> {
    const response = await fetch('/api/nfe/enviar', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            nfeId,
            ambiente
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erro ao enviar NFe para SEFAZ: ${text}`);
    }

    return response.json();
}

/**
 * PHASE 3 SOAP REAL: Consultar Status com SOAP real
 */
export async function consultarStatusNFeSoapReal(
    chaveAcesso: string,
    ambiente: 'PRODUÇÃO' | 'HOMOLOGAÇÃO'
): Promise<any> {
    const response = await fetch(`/api/nfe/consultar-status?chaveAcesso=${chaveAcesso}&ambiente=${ambiente}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error('Erro ao consultar status SEFAZ');
    }

    return response.json();
}

/**
 * PHASE 3 SOAP REAL: Cancelar NFe com integração SOAP real
 */
export async function cancelarNFeSoapReal(
    nfeId: string,
    justificativa: string
): Promise<any> {
    const response = await fetch('/api/nfe/cancelar', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            nfeId,
            justificativa
        })
    });

    if (!response.ok) {
        throw new Error('Erro ao cancelar NFe');
    }

    return response.json();
}
