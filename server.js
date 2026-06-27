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
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // Limite 10MB para pruebas
const sentiment = new Sentiment();

// 1. Configuración de Middlewares (Seguridad CORS Corregida con Arreglo y Comas)
app.use(cors({
  origin: [
    'https://sensational-druid-fcbe07.netlify.app',
    'https://sensational-druid-fcbe07.netlify.app/'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());


// 2. CONFIGURACIÓN DIRECTA Y SEGURA DE SUPABASE (URL Sanitizada sin sub-rutas)
const supabaseUrl = 'https://zhtclrjpowktkcnccmwx.supabase.co'; 
const supabaseKey = 'sb_publishable_DowdOFlmdEUVv5FgeiT7EQ_fO170UiQ';

console.log("=== CONTROL DE CONEXIÓN DIRECTA ===");
console.log("URL Configurada:", supabaseUrl ? "Asignada Correctamente" : "Vacía");

const supabase = createClient(supabaseUrl, supabaseKey);


// 3. DICCIONARIO DE SALUDOS REQUERIDO POR TU LOGICA
const DICCIONARIO_SALUDOS = ['hola', 'buenos dias', 'saludos', 'buenas tardes', 'buenas noches', 'buen dia'];


// 4. TU FUNCIÓN ORIGINAL DE ANALÍTICA (Declarada antes del endpoint para evitar Scope errors)
function clasificarYSentimiento(textoOriginal) {
    const textoLimpio = textoOriginal ? textoOriginal.trim() : "";
    if (textoLimpio === "") {
        return { tipo: 'Solo Comentarios', sentimiento: 'Neutral', hashtagsLimpios: [] };
    }

    // Manejo de Hashtags y Emojis
    const hashtags = textoLimpio.match(/#\w+/g) || [];
    const textoSinEmojis = emoji.strip(textoLimpio).trim();
    const teniaEmojis = emoji.hasEmoji(textoLimpio);

    // Evaluar Saludo Puro
    const palabraLimpia = textoSinEmojis.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    const esSaludoPuro = DICCIONARIO_SALUDOS.includes(palabraLimpia);

    // Jerarquía de Reglas
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

    // Análisis de Sentimiento
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
        const resultadoScore = sentiment.analyze(textoLimpio);
        if (resultadoScore.score > 0) analisisSentimiento = 'Positivo';
        if (resultadoScore.score < 0) analisisSentimiento = 'Negativo';
    }

    return { 
        tipo, 
        sentimiento: analisisSentimiento, 
        hashtagsLimpios: hashtags.map(tag => tag.replace('#', '').toLowerCase()) 
    };
}


// 5. ENDPOINT CRÍTICO: INGESTA DE CSV (Escuchando en /api/upload de forma robusta)
app.post('/api/upload', upload.any(), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No se subió ningún archivo CSV." });
        }
        
        const archivoSubido = req.files[0];
        const esEnVivo = req.body.is_live_comment === 'true';

        // Obtener el número consecutivo correlativo del archivo
        const { data: ultimoComentario } = await supabase
            .from('youtube_comments')
            .select('file_sequence_number')
            .order('file_sequence_number', { ascending: false })
            .limit(1)
            .maybeSingle();

        const consecutivoActual = ultimoComentario ? ultimoComentario.file_sequence_number + 1 : 1;

        // PARSEO DEL ARCHIVO CSV DESDE MEMORIA BUFFER
        const resultadosCsv = [];
        const bufferStream = new stream.PassThrough();
        bufferStream.end(archivoSubido.buffer);

        bufferStream
            .pipe(csv())
            .on('data', (data) => resultadosCsv.push(data))
            .on('end', async () => {
                try {
                    console.log(`💬 CSV leído en memoria. Procesando ${resultadosCsv.length} filas...`);
                    
                    for (const fila of resultadosCsv) {
                        const authorName = fila['Author Name'] || fila['author_name'];
                        const commentText = fila['Comments Text'] || fila['comments_text'];
                        const videoTime = fila['Video Time'] || fila['video_time'];
                        const messageTime = fila['Message Time'] || fila['message_time'];
                        const channelUrl = fila['Author Channel URL'] || fila['author_channel_url'];
                        const idOriginal = fila['Id'] || fila['id'];

                        if (!authorName) continue; // Saltar filas vacías o corruptas

                        const textoProcesadoEmojis = emoji.emojify(commentText || "");
                        const analitica = clasificarYSentimiento(textoProcesadoEmojis);

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
                                    url_canal: channelUrl || null,
                                    es_externo: true,
                                    pendiente_actualizacion: true
                                }]);
                        }

                        // INSERCION DEL COMENTARIO
                        const { data: comentarioInsertado, error: errComment } = await supabase
                            .from('youtube_comments')
                            .insert([{
                                file_sequence_number: consecutivoActual,
                                youtube_id: idOriginal || null,
                                author_name: authorName,
                                comments_text: textoProcesadoEmojis,
                                video_time: videoTime || null,
                                message_time: messageTime ? new Date(messageTime) : new Date(),
                                author_channel_url: channelUrl || null,
                                is_live_comment: esEnVivo,
                                tipo_comentario: analitica.tipo,
                                sentimiento: analitica.sentimiento
                            }])
                            .select('internal_id')
                            .single();

                        if (errComment) {
                            console.error("❌ Error insertando comentario en Supabase:", errComment);
                        }

                        // INSERCIÓN DE HASHTAGS (Si existen)
                        if (comentarioInsertado && analitica.hashtagsLimpios.length > 0) {
                            const insertsHashtags = analitica.hashtagsLimpios.map(tag => ({
                                comment_id: comentarioInsertado.internal_id,
                                hashtag: tag
                            }));
                            await supabase.from('comment_hashtags').insert(insertsHashtags);
                        }
                    }

                    console.log("✅ ¡Procesamiento completado exitosamente!");
                    return res.json({ 
                        mensaje: "Archivo procesado e ingresado exitosamente.", 
                        consecutivo_asignado: consecutivoActual,
                        total_registros: resultadosCsv.length
                    });

                } catch (errInterno) {
                    console.error("❌ ERROR CRÍTICO DENTRO DEL BUCLE CSV:", errInterno);
                    return res.status(500).json({ error: "Falla interna al procesar las filas del CSV.", detalle: errInterno.message });
                }
            });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Falla crítica en el procesamiento del servidor." });
    }
});


// 6. ENDPOINT PARA DASHBOARD DINÁMICO
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


// Inicialización de Puerto para Render
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend escuchando exitosamente en el puerto ${PORT}`);
});