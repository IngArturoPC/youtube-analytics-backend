require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parser');
const emoji = require('node-emoji');
const Sentiment = require('sentiment-spanish');
const { createClient } = require('@supabase/supabase-js');
const stream = require('stream');

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // Limite 10MB
const sentiment = new Sentiment();

// 1. Configuración de Middlewares (Seguridad CORS Flexible)
app.use(cors({
  origin: [
    'https://sensational-druid-fcbe07.netlify.app',
    'https://sensational-druid-fcbe07.netlify.app/'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());


// 2. CONFIGURACIÓN DIRECTA DE SUPABASE (URL Sanitizada sin sub-rutas)
const supabaseUrl = 'https://zhtclrjpowktkcnccmwx.supabase.co'; 
const supabaseKey = 'sb_publishable_DowdOFlmdEUVv5FgeiT7EQ_fO170UiQ';

console.log("=== CONTROL DE CONEXIÓN DIRECTA ===");
console.log("URL Supabase Base: Configurada Correctamente");

const supabase = createClient(supabaseUrl, supabaseKey);


// 3. DICCIONARIO DE SALUDOS
const DICCIONARIO_SALUDOS = ['hola', 'buenos dias', 'saludos', 'buenas tardes', 'buenas noches', 'buen dia'];


// 4. FUNCIÓN DE ANALÍTICA Y SENTIMIENTO (Blindada)
function clasificarYSentimiento(textoOriginal) {
    const textoLimpio = textoOriginal ? textoOriginal.trim() : "";
    if (textoLimpio === "") {
        return { tipo: 'Solo Comentarios', sentimiento: 'Neutral', hashtagsLimpios: [] };
    }

    const hashtags = textoLimpio.match(/#\w+/g) || [];
    const textoSinEmojis = emoji.strip(textoLimpio).trim();
    const teniaEmojis = emoji.hasEmoji(textoLimpio);

    const palabraLimpia = textoSinEmojis.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    const esSaludoPuro = DICCIONARIO_SALUDOS.includes(palabraLimpia);

    let tipo = 'Solo Comentarios';
    const textoSinEspacios = textoLimpio.replace(/\s+/g, '');
    const todosHashtagsUnidos = hashtags.join('');

    if (hashtags.length > 0 && textoSinEspacios === todosHashtagsUnidos) {
        tipo = 'Solo HashTag';
    } else if (teniaEmojis && textoSinEmojis === "") {
        tipo = 'Solo Emoticons';
    } else if (esSaludoPuro && hashtags.length === 0) {
        tipo = 'Solo Saludos';
    } else if (hashtags.length > 0) {
        tipo = 'Comentarios con HashTag';
    }

    let analisisSentimiento = 'Neutral';
    if (tipo === 'Solo Emoticons') {
        if (textoLimpio.includes('❤️') || textoLimpio.includes('🔥') || textoLimpio.includes('😂') || textoLimpio.includes('👍')) {
            analisisSentimiento = 'Positivo';
        } else if (textoLimpio.includes('😡') || textoLimpio.includes('🤮') || textoLimpio.includes('👎')) {
            analisisSentimiento = 'Negativo';
        }
    } else if (tipo === 'Solo Saludos') {
        analisisSentimiento = 'Positivo';
    } else {
        try {
            const resultadoScore = (typeof sentiment.analyze === 'function') 
                ? sentiment.analyze(textoLimpio) 
                : (typeof sentiment === 'function' ? sentiment(textoLimpio) : { score: 0 });

            if (resultadoScore && resultadoScore.score > 0) analisisSentimiento = 'Positivo';
            else if (resultadoScore && resultadoScore.score < 0) analisisSentimiento = 'Negativo';
        } catch (e) {
            analisisSentimiento = 'Neutral';
        }
    }

    return { 
        tipo, 
        sentimiento: analisisSentimiento, 
        hashtagsLimpios: hashtags.map(tag => tag.replace('#', '').toLowerCase()) 
    };
}


// 5. ENDPOINT REESCRITO CON LAS NUEVAS REGLAS ANALÍTICAS
app.post('/api/upload', upload.any(), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No se subió ningún archivo CSV." });
        }
        
        const archivoSubido = req.files[0];
        const nombreArchivo = archivoSubido.originalname || ""; // Ej: data20260521.csv
        const esEnVivo = req.body.is_live_comment === 'true';

        // --- EXTRACCIÓN DINÁMICA DE FECHAS DESDE EL NOMBRE DEL ARCHIVO ---
        let fechaTxt = "00000000";
        let anoTxt = "0000";
        let anoMesTxt = "0000-00";

        // Busca una secuencia de 8 números en el nombre del archivo (ej: 20260521)
        const matchFecha = nombreArchivo.match(/\d{8}/);
        if (matchFecha) {
            fechaTxt = matchFecha[0]; // "20260521"
            anoTxt = fechaTxt.substring(0, 4); // "2026"
            anoMesTxt = `${anoTxt}-${fechaTxt.substring(4, 6)}`; // "2026-05"
        }

        console.log(`📂 Procesando archivo: ${nombreArchivo}`);
        console.log(`📆 Dimensiones detectadas -> Fecha: ${fechaTxt}, Año: ${anoTxt}, Período: ${anoMesTxt}`);

        // PARSEO DEL ARCHIVO CSV
        const resultadosCsv = [];
        const bufferStream = new stream.PassThrough();
        bufferStream.end(archivoSubido.buffer);

        bufferStream
            .pipe(csv())
            .on('data', (data) => resultadosCsv.push(data))
            .on('end', async () => {
                try {
                    console.log(`💬 CSV cargado. Procesando ${resultadosCsv.length} registros...`);
                    
                    // Inicializar contador consecutivo en 1 para este archivo específico
                    let contadorFila = 1;

                    for (const fila of resultadosCsv) {
                        const authorName = fila['Author Name'] || fila['author_name'];
                        const commentText = fila['Comments Text'] || fila['comments_text'];
                        const messageTime = fila['Message Time'] || fila['message_time'];

                        if (!authorName) continue; // Saltar filas vacías

                        // Procesamiento semántico
                        const textoProcesadoEmojis = emoji.emojify(commentText || "");
                        const analitica = clasificarYSentimiento(textoProcesadoEmojis);

                        // Cálculo dinámico de URL del Canal
                        const urlCanalCalculada = `https://www.youtube.com/${encodeURIComponent(authorName.trim())}`;

                        // LÓGICA UPSERT DE USUARIO EXTERNO
                        const { data: usuarioExistente } = await supabase
                            .from('catalogo_usuarios_youtube')
                            .select('usuario_llave')
                            .eq('usuario_llave', authorName)
                            .maybeSingle();

                        if (!usuarioExistente) {
                            await supabase
                                .from('catalogo_usuarios_youtube')
                                .insert([{
                                    usuario_youtube_display: authorName,
                                    usuario_llave: authorName,
                                    url_canal: urlCanalCalculada,
                                    es_externo: true,
                                    pendiente_actualizacion: true
                                }]);
                        }

                        // INSERCIÓN SIMPLIFICADA DEL COMENTARIO (Cumpliendo la nueva estructura)
                        const { data: comentarioInsertado, error: errComment } = await supabase
                            .from('youtube_comments')
                            .insert([{
                                internal_id: contadorFila,          // Consecutivo dinámico local (1, 2, 3...)
                                author_name: authorName,
                                comments_text: textoProcesadoEmojis,
                                message_time: messageTime ? new Date(messageTime) : new Date(),
                                author_channel_url: urlCanalCalculada,
                                is_live_comment: esEnVivo,
                                tipo_comentario: analitica.tipo,
                                sentimiento: analitica.sentimiento,
                                uploaded_at: new Date(),            // Fecha de carga calculada por el backend
                                fecha_txt: fechaTxt,                // "20260521"
                                año_txt: anoTxt,                    // "2026"
                                año_mes_txt: anoMesTxt              // "2026-05"
                            }])
                            .select('internal_id') 
                            .maybeSingle();

                        if (errComment) {
                            console.error(`❌ Error en fila ${contadorFila} (Autor: ${authorName}):`, errComment.message);
                        }

                        // INSERCIÓN DE HASHTAGS (Si existen)
                        if (comentarioInsertado && analitica.hashtagsLimpios.length > 0) {
                            const insertsHashtags = analitica.hashtagsLimpios.map(tag => ({
                                comment_id: comentarioInsertado.internal_id,
                                hashtag: tag
                            }));
                            await supabase.from('comment_hashtags').insert(insertsHashtags);
                        }

                        // Incrementar el consecutivo para la siguiente fila del archivo
                        contadorFila++;
                    }

                    console.log("✅ ¡Procesamiento e ingesta completados exitosamente!");
                    return res.json({ 
                        mensaje: "Archivo procesado e ingresado exitosamente.", 
                        total_registros: resultadosCsv.length
                    });

                } catch (errInterno) {
                    console.error("❌ ERROR EN EL PROCESAMIENTO INTERNO:", errInterno);
                    return res.status(500).json({ error: "Falla interna al procesar el archivo.", detalle: errInterno.message });
                }
            });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Falla crítica en el servidor." });
    }
});


// 6. ENDPOINT PARA DASHBOARD
app.get('/api/dashboard/metrics', async (req, res) => {
    try {
        const { count: totalComentarios } = await supabase.from('youtube_comments').select('*', { count: 'exact', head: true });
        const { count: pendientesAjuste } = await supabase.from('catalogo_usuarios_youtube').select('*', { count: 'exact', head: true }).eq('pendiente_actualizacion', true);

        res.json({
            total_comentarios_acumulados: totalComentarios,
            alertas_usuarios_externos: pendientesAjuste
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend escuchando exitosamente en el puerto ${PORT}`);
});