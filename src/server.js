import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors())
app.use(express.json())

const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes("rlwy") ? { rejectUnauthorized: false } : undefined
});

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:5173";
const LINK_TTL_HOURS = Number(process.env.LINK_TTL_HOURS || 48);

const normCpf = (v) => String(v || "").replace(/\D/g, "");
const tokenRand = () => crypto.randomBytes(16).toString("hex");

const desconto = 0;
const parcelas = 0;
const valorParcelas = 0;

function acordo(valor) {
  let minParcela = 0;
  let acima = false;
  let entradaPct = 0;

  if (valor > 750 && valor <= 3500) {
    entradaPct = 0.25;
    minParcela = 275;

  } else if (valor > 3500 && valor <= 5000) {
    entradaPct = 0.30;
    minParcela = 450;

  } else if (valor > 5000 && valor <= 7500) {
    entradaPct = 0.35;
    minParcela = 710;

  } else if (valor > 7500) {
    acima = true;

  } else {
    entradaPct = 0;
    minParcela = 200;
  }

  if (acima) return null;

  const entrada = valor * entradaPct;
  const restante = valor - entrada;
  let parcelas = Math.floor(restante / minParcela);

  if (parcelas < 1) parcelas = 1;

  const valorParcelas = restante / parcelas;

  return {
    entradaPct: entradaPct * 100,
    entrada,
    parcelas,
    valorParcelas
  };
}


// ------------------------------------------------------------------------------------------

// gera o link
app.post("/api/link", async (req, res) => {
    const { id_unidade } = req.body || {};
    if (!id_unidade) return res.status(400).json({ error: "Obrigatório informar unidade!" });

    const token = tokenRand();
    const expiraEm = new Date(Date.now() + LINK_TTL_HOURS * 60 * 60 * 1000);

    await pool.query(`UPDATE cobranca_links SET status = 'CANCELADO' WHERE  id_unidade = $1`,[id_unidade])

    await pool.query(
        `INSERT INTO cobranca_links (token, id_unidade, expira_em) VALUES ($1,$2,$3)`,
        [token, id_unidade, expiraEm]
    );

    res.json({ url: `${PUBLIC_BASE_URL}/cobranca/${token}`, token, expira_em: expiraEm.toISOString() });
});


// valida CPF
app.post("/api/validar", async (req, res) => {
    const token = String(req.body?.token || "");
    const cpf = normCpf(req.body?.cpf)

    if (!token || !cpf) return res.status(400).json({ error: "Token e CPF são obrigatórios!" });

    const linkR = await pool.query(`SELECT * FROM cobranca_links WHERE token=$1`, [token]);
    if (linkR.rowCount === 0) return res.status(401).json({ ok: false, error: "Link inválido!" });

    const link = linkR.rows[0];
    if (link.status !== "ATIVO") return res.status(401).json({ ok: false, error: "Link inativo ou indisponível!" })
    if (new Date(link.expira_em).getTime() < Date.now()) return res.status(401).json({ ok: false, error: "Link expirado!" })
    if (link.tentativas >= link.max_tentativas) return res.status(401).json({ ok: false, error: "Link bloqueado!" })

    const moraR = await pool.query(`SELECT cpf FROM unidade WHERE id=$1 LIMIT 1`, [link.id_unidade]);
    if (moraR === 0) return res.status(401).json({ ok: false, error: "Unidade não encontrada!" })

    const cpfReal = normCpf(moraR.rows[0].cpf);
    if (cpfReal !== cpf) {
        await pool.query(`UPDATE cobranca_links SET tentativas = tentativas + 1 WHERE token=$1`, [token]);
        return res.status(401).json({ ok: false, error: "Dados não conferem" });
    }

    await pool.query(`UPDATE cobrancas_sessoes SET status=false WHERE id_cobrancas_links = $1`,[link.id])

    const sessaoToken = crypto.randomBytes(24).toString("hex");
    const expiraSessao = new Date(Date.now() + 15 * 60 * 1000);

    await pool.query(`
        INSERT INTO cobrancas_sessoes (id_cobrancas_links, sessao_token, expira_em) VALUES ($1,$2,$3)
        `, [link.id, sessaoToken, expiraSessao]);

    return res.json({ ok: true, sessao_token: sessaoToken });
});


// pega dados
app.get("/api/dados", async (req, res) => {
    const sessao = String(req.query?.token || "").trim();
    if (!sessao) return res.status(401).json({ error: "Sessão ausente" });

    const sR = await pool.query(
        `SELECT s.expira_em, l.id_unidade
       FROM cobrancas_sessoes s
       JOIN cobranca_links l ON l.id = s.id_cobrancas_links
      WHERE s.sessao_token =$1 AND s.status = true
      LIMIT 1`,
        [sessao]
    );

    if (sR.rowCount === 0) return res.status(401).json({ error: "Sessão inválida" });

    const { expira_em, id_unidade } = sR.rows[0];
    if (new Date(expira_em).getTime() < Date.now()) {
        return res.status(401).json({ error: "Sessão expirada" });
    }

    const mR = await pool.query(`
        SELECT * FROM unidade WHERE id =$1
        `, [id_unidade])

   const {unidade} = mR.rows[0]
    const debR = await pool.query(`
        SELECT * FROM debitos WHERE unidade = $1
        ORDER BY TO_DATE(vencimento, 'DD/MM/YY') DESC
        `, [unidade]);


    const boletos = debR.rows.map(r => ({
        vencimento: r.vencimento,
        competencia: r.competencia,
        atraso: r.atraso,
        original: r.original,
        juros: r.juros,
        multa: r.multa,
        atualizacao: r.atualizacao,
        honorarios: r.honorarios,
        total: Number(r.total)
    }))

    const dividaTotal = boletos.reduce(
        (acc, boleto) => acc + (Number(boleto.total) || 0), 0
    );

   
    res.json({
        morador: mR.rows[0] || { id_unidade },
        boletos,
        dividaTotal,
        acordo: acordo(dividaTotal)
    });

});


app.listen(process.env.PORT || 3000, () => console.log("API ok"));
