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

// Configuración de Middlewares (Soporta peticiones desde tu Netlify)
app.use(cors({
  origin: [
    'https://sensational-druid-fcbe07.netlify.app',
    'https://sensational-druid-fcbe07.netlify.app/'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// 2. CONFIGURACIÓN DE SUPABASE (Usando la clave Service Role desde las variables de entorno)
const supabaseUrl = 'https://zhtclrjpowktkcnccmwx.supabase.co'; 
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_DowdOFlmdEUVv5FgeiT7EQ_fO170UiQ';

console.log("=== CONTROL DE CONEXIÓN DIRECTA ===");
console.log("Instanciando cliente de Supabase...");

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

// 3. DICCIONARIO DE SALUDOS EXTENDIDO
const DICCIONARIO_SALUDOS = ['hola', 'buenos dias', 'saludos', 'buenas tardes', 'buenas noches', 'buen dia', 'saludo', 'gracias'];

// 4. FUNCIÓN INTEGRADORA: CLASIFICACIÓN DE TIPO (5 CATEGORÍAS) Y SENTIMIENTO
function clasificarYSentimiento(textoOriginal) {
    const textoLimpio = textoOriginal ? textoOriginal.trim() : "";
    if (textoLimpio === "") {
        return { tipo: 'Solo Comentarios', sentimiento: 'Neutral', hashtagsLimpios: [] };
    }

    // Extracción de Hashtags
    const regexHashtags = /#\w+/g;
    const hashtags = textoLimpio.match(regexHashtags) || [];
    const hashtagsLimpios = [...new Set(hashtags)].map(tag => tag.replace('#', '').toLowerCase());

    // Análisis de Emojis y Limpieza de texto
    const textoSinEmojis = emoji.strip(textoLimpio).trim();
    
    // CORRECCIÓN: Compara el texto antes y después de quitar los emojis (Sin usar hasEmoji)
    const teniaEmojis = emoji.strip(textoLimpio) !== textoLimpio;

    // Palabras limpias para detectar Saludos
    const palabras = textoSinEmojis.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "").split(/\s+/);
    const contieneSaludo = palabras.some(palabra => DICCIONARIO_SALUDOS.includes(palabra));

    let tipo = 'Solo Comentarios';
    const textoSinEspacios = textoLimpio.replace(/\s+/g, '');
    const todosHashtagsUnidos = hashtags.join('');

    // --- REGLAS DE ASIGNACIÓN RIGUROSAS ---
    if (hashtags.length > 0 && textoSinEspacios === todosHashtagsUnidos) {
        tipo = 'Solo HashTag';
    } else if (teniaEmojis && textoSinEmojis === "") {
        tipo = 'Solo Emoticons';
    } else if (contieneSaludo && hashtags.length === 0) {
        tipo = 'Solo Saludos';
    } else if (hashtags.length > 0) {
        tipo = 'Comentarios con HashTag';
    } else {
        tipo = 'Solo Comentarios';
    }

    // --- EVALUACIÓN DE SENTIMIENTO ---
    let analisisSentimiento = 'Neutral';
    if (tipo === 'Solo Emoticons') {
        if (textoLimpio.includes('❤️') || textoLimpio.includes('🔥') || textoLimpio.includes('😂') || textoLimpio.includes('👍') || textoLimpio.includes('👏')) {
            analisisSentimiento = 'Positivo';
        } else if (textoLimpio.includes('😡') || textoLimpio.includes('🤮') || textoLimpio.includes('👎')) {
            analisisSentimiento = 'Negativo';
        }
    } else if (tipo === 'Solo Saludos') {
        analisisSentimiento = 'Positivo';
    } else {
        try {
            const resultadoScore = sentiment.analyze(textoLimpio);
            if (resultadoScore && resultadoScore.score > 0) analisisSentimiento = 'Positivo';
            else if (resultadoScore && resultadoScore.score < 0) analisisSentimiento = 'Negativo';
        } catch (e) {
            analisisSentimiento = 'Neutral';
        }
    }

    return { tipo, sentimiento: analisisSentimiento, hashtagsLimpios };
}

// 5. ENDPOINT PARA PROCESAR EL CSV (Estructura Blindada con Promesa Nativa)
app.post('/api/comments/upload-csv', upload.any(), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No se subió ningún archivo CSV." });
        }
        
        const archivoSubido = req.files[0];
        const nombreArchivo = archivoSubido.originalname || ""; 
        const esEnVivo = req.body.is_live_comment === 'true';

        // --- EXTRACCIÓN DINÁMICA DE FECHAS (Año 2000 a 2099) ---
        let fechaTxt = "00000000";
        let anioTxt = "0000";
        let anioMesTxt = "0000-00";

        const matchFecha = nombreArchivo.match(/20\d{6}/);
        if (matchFecha) {
            fechaTxt = matchFecha[0]; 
            anioTxt = fechaTxt.substring(0, 4); 
            anioMesTxt = `${anioTxt}-${fechaTxt.substring(4, 6)}`; 
        }

        console.log(`📂 Archivo Recibido: ${nombreArchivo} | Dimensiones: Fecha=${fechaTxt}, Periodo=${anioMesTxt}`);

        const resultadosCsv = [];
        const bufferStream = new stream.PassThrough();
        bufferStream.end(archivoSubido.buffer);

        // 🌟 REGLA 1 y 2: Envolvemos el flujo del Stream en una Promesa para controlar a Express
        const totalRegistrosProcesados = await new Promise((resolve, reject) => {
            bufferStream
                .pipe(csv())
                .on('data', (data) => resultadosCsv.push(data))
                .on('error', (errStream) => reject(errStream)) // Si falla el parseo, aborta inmediatamente
                .on('end', async () => {
                    try {
                        console.log(`💬 Procesando lote de ${resultadosCsv.length} filas del CSV...`);

                        for (const fila of resultadosCsv) {
                            const numConsecutivo = fila['Num'];
                            const authorNameRaw = fila['Author Name'] || fila['author_name'];
                            const commentText = fila['Comments Text'] || fila['comments_text'] || "";
                            const videoTime = fila['Video Time'] || fila['video_time'] || null;
                            const messageTime = fila['Message Time'] || fila['message_time'];
                            const authorChannelUrlRaw = fila['Author Channel URL'] || fila['author_channel_url'] || "";

                            if (!authorNameRaw) continue; 

                            // Tratamiento del prefijo '@'
                            const authorNameClean = authorNameRaw.trim();
                            const authorName = authorNameClean.startsWith('@') ? authorNameClean : `@${authorNameClean}`;
                            const urlCanalCalculada = authorChannelUrlRaw || `https://www.youtube.com/${authorName}`;

                            // Análisis semántico
                            const textoProcesadoEmojis = emoji.emojify(commentText);
                            const analitica = clasificarYSentimiento(textoProcesadoEmojis);

                            // UPSERT del Catálogo de Usuarios
                            const { error: errUpsertUser } = await supabase
                                .from('catalogo_usuarios_youtube')
                                .upsert(
                                    {
                                        usuario_youtube_display: authorName,
                                        usuario_llave: authorName, 
                                        url_canal: urlCanalCalculada,
                                        es_externo: true,
                                        pendiente_actualizacion: true
                                    },
                                    { onConflict: 'usuario_llave', ignoreDuplicates: true }
                                );

                            if (errUpsertUser) {
                                console.warn(`⚠️ Error al asegurar el usuario ${authorName} (Num CSV: ${numConsecutivo}):`, errUpsertUser.message);
                                continue;
                            }

                            // Inserción del Comentario
                            const { data: comentarioInsertado, error: errComment } = await supabase
                                .from('youtube_comments')
                                .insert([{
                                    file_sequence_number: Number(numConsecutivo) || 1,
                                    author_name: authorName,
                                    comments_text: textoProcesadoEmojis,
                                    video_time: videoTime,
                                    message_time: messageTime ? new Date(messageTime) : new Date(),
                                    author_channel_url: urlCanalCalculada,
                                    is_live_comment: esEnVivo,
                                    tipo_comentario: analitica.tipo,
                                    sentimiento: analitica.sentimiento,
                                    uploaded_at: new Date(),            
                                    fecha_txt: fechaTxt,                
                                    anio_mes_txt: anioMesTxt            
                                }])
                                .select('internal_id') 
                                .maybeSingle();
                                                            
                            if (errComment) {
                                console.error(`❌ Error insertando comentario (Num CSV: ${numConsecutivo}):`, errComment.message);
                                continue;
                            }

                            // Inserción de Hashtags relacionales
                            if (comentarioInsertado && analitica.hashtagsLimpios.length > 0) {
                                const insertsHashtags = analitica.hashtagsLimpios.map(tag => ({
                                    comment_id: comentarioInsertado.internal_id, 
                                    author_name: authorName,                       
                                    hashtag: tag                                   
                                }));
                                
                                const { error: errTags } = await supabase.from('comment_hashtags').insert(insertsHashtags);
                                if (errTags) {
                                    console.warn(`⚠️ Error insertando hashtag (Num CSV: ${numConsecutivo}):`, errTags.message);
                                }
                            }
                        }

                        // Al terminar el bucle exitosamente, resolvemos la Promesa devolviendo el total
                        resolve(resultadosCsv.length);

                    } catch (errBucle) {
                        reject(errBucle);
                    }
                });
        });

        // 🌟 LA RESPUESTA QUEDA FUERA DEL STREAM: Sincronización perfecta con Express
        console.log("✅ ¡Procesamiento e ingesta de datos completada exitosamente!");
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).send(JSON.stringify({ 
            mensaje: "Archivo procesado e ingresado exitosamente.", 
            total_registros: Number(totalRegistrosProcesados)
        }));

    } catch (error) {
        console.error("❌ FALLA CRÍTICA EN EL ENDPOINT:", error);
        // Al estar fuera del stream, este catch captura fallas de compilación o de Supabase limpiamente
        if (!res.headersSent) {
            return res.status(500).json({ error: "Falla crítica en el servidor.", detalle: error.message });
        }
    }
});

// 6. ENDPOINT PARA DASHBOARD
app.get('/api/dashboard/metrics', async (req, res) => {
    try {
        const { count: totalComentarios } = await supabase.from('youtube_comments').select('*', { count: 'exact', head: true });[cite: 1]
        const { count: pendientesAjuste } = await supabase.from('catalogo_usuarios_youtube').select('*', { count: 'exact', head: true }).eq('pendiente_actualizacion', true);[cite: 1]

        res.json({
            total_comentarios_acumulados: totalComentarios,[cite: 1]
            alertas_usuarios_externos: pendientesAjuste[cite: 1]
        });
    } catch (error) {
        res.status(500).json({ error: error.message });[cite: 1]
    }
});

const PORT = process.env.PORT || 5000;[cite: 1]
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend escuchando exitosamente en el puerto ${PORT}`);[cite: 1]
});