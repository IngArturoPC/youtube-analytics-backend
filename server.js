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

// Configuración de Middlewares (Seguridad)
app.use(cors({
  origin: 'https://sensational-druid-fcbe07.netlify.app', // Tu URL de Netlify sin la diagonal al final
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());


console.log("Revisando variables en Render:", {
  hasUrl: !!process.env.SUPABASE_URL,
  hasKey: !!process.env.SUPABASE_KEY
});

// Inicialización del Cliente de Supabase (Limpiando espacios invisibles con .trim())
const supabase = createClient(
  (process.env.SUPABASE_URL || '').trim(), 
  (process.env.SUPABASE_KEY || '').trim()
);

// DICCIONARIO PARA REGLA DE "SOLO SALUDOS"
const DICCIONARIO_SALUDOS = [
    'presente', 'aqui estoy', 'aquí estoy', 'hola', 'saludos', 
    'buenos dias', 'buenos días', 'buenas tardes', 'buenas noches', 
    'listo', 'lista', 'unidos', 'apoyo'
];

// =====================================================================
// FUNCIONES AUXILIARES DE PROCESAMIENTO (MÓDULO ETL & ANALYTICS)
// =====================================================================

function clasificarYSentimiento(textoOriginal) {
    const textoLimpio = textoOriginal ? textoOriginal.trim() : "";
    if (textoLimpio === "") {
        return { tipo: 'Solo Comentarios', sentimiento: 'Neutral' };
    }

    // 1. Manejo de Hashtags y Emojis
    const hashtags = textoLimpio.match(/#\w+/g) || [];
    const textoSinEmojis = emoji.strip(textoLimpio).trim();
    const teniaEmojis = emoji.hasEmoji(textoLimpio);

    // 2. Evaluar Saludo Puro
    const palabraLimpia = textoSinEmojis.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    const esSaludoPuro = DICCIONARIO_SALUDOS.includes(palabraLimpia);

    // ─── Jerarquía de Reglas ───
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

    // ─── Análisis de Sentimiento Basado en Reglas/Diccionario ───
    let analisisSentimiento = 'Neutral';
    if (tipo === 'Solo Emoticons') {
        // Regla simple para emojis comunes de prueba
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

    return { tipo, sentimiento: analisisSentimiento, hashtagsLimpios: hashtags.map(tag => tag.replace('#', '').toLowerCase()) };
}

// =====================================================================
// ENDPOINTS / RUTAS DE LA API
// =====================================================================

// Explicación de objetivo de sitio (Requerimiento 1)
app.get('/api/info', (req, res) => {
    res.json({
        objetivo: "Plataforma modular para el análisis semántico, clasificación de sentimiento y asignación de control de interacciones/comentarios de YouTube orientada a la gestión organizacional de organizaciones aliadas."
    });
});

// Endpoint Crítico: Ingesta de CSV de Comentarios (Solo Admin de forma lógica)
app.post('/api/comments/upload-csv', upload.single('archivo_comentarios'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No se subió ningún archivo CSV." });
        
        // Determinar si el usuario indicó si es en vivo o estático desde el frontend
        const esEnVivo = req.body.is_live_comment === 'true';

        // 1. Obtener el número consecutivo correlativo del archivo
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
        bufferStream.end(req.file.buffer);

        bufferStream
            .pipe(csv())
            .on('data', (data) => resultadosCsv.push(data))
            .on('end', async () => {
                
                // Procesamiento secuencial controlado para garantizar integridad
                for (const fila of resultadosCsv) {
                    const authorName = fila['Author Name'] || fila['author_name'];
                    const commentText = fila['Comments Text'] || fila['comments_text'];
                    const videoTime = fila['Video Time'] || fila['video_time'];
                    const messageTime = fila['Message Time'] || fila['message_time'];
                    const channelUrl = fila['Author Channel URL'] || fila['author_channel_url'];
                    const idOriginal = fila['Id'] || fila['id'];

                    if (!authorName) continue; // Saltar filas corruptas

                    // A. Intercambio de Emoticones de Texto a Gráfico si aplica
                    const textoProcesadoEmojis = emoji.emojify(commentText || "");

                    // B. Clasificación y Sentimiento Automático
                    const analitica = clasificarYSentimiento(textoProcesadoEmojis);

                    // C. LÓGICA UPSERT DE USUARIO EXTERNO
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

                    // D. INSERCIÓN DEL COMENTARIO
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

                    // E. INSERCIÓN DE HASHTAGS (Si existen)
                    if (comentarioInsertado && analitica.hashtagsLimpios.length > 0) {
                        const insertsHashtags = analitica.hashtagsLimpios.map(tag => ({
                            comment_id: comentarioInsertado.internal_id,
                            hashtag: tag
                        }));
                        await supabase.from('comment_hashtags').insert(insertsHashtags);
                    }
                }

                return res.json({ 
                    mensaje: "Archivo procesado e ingresado exitosamente.", 
                    consecutivo_asignado: consecutivoActual,
                    total_registros: resultadosCsv.length
                });
            });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Falla crítica en el procesamiento del servidor." });
    }
});

// Endpoint para el Dashboard Dinámico (Muestra métricas unificadas)
app.get('/api/dashboard/metrics', async (req, res) => {
    try {
        // Consultas agrupadas rápidas aprovechando los índices creados
        const { data: tipoMétricas } = await supabase.rpc('get_comments_by_type_summary'); 
        // Nota: Para la prueba ágil, podemos resolverlo también directamente mediante consultas de conteo normales:
        
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
    console.log(`Servidor de pruebas corriendo en puerto ${PORT}`);
});