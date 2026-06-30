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

// 2. CONFIGURACIÓN DE SUPABASE
const supabaseUrl = 'https://zhtclrjpowktkcnccmwx.supabase.co'; 
const supabaseKey = 'sb_publishable_DowdOFlmdEUVv5FgeiT7EQ_fO170UiQ';
const supabase = createClient(supabaseUrl, supabaseKey);

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
    const teniaEmojis = emoji.hasEmoji(textoLimpio);

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

// 5. ENDPOINT PARA PROCESAR EL CSV (Escuchando en la ruta exacta requerida por el frontend)
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

        bufferStream
            .pipe(csv())
            .on('data', (data) => resultadosCsv.push(data))
            .on('end', async () => {
                try {
                    console.log(`💬 Procesando lote de ${resultadosCsv.length} filas del CSV...`);
                    let contadorFila = 1;

                    for (const fila of resultadosCsv) {
                        const authorNameRaw = fila['Author Name'] || fila['author_name'];
                        const commentText = fila['Comments Text'] || fila['comments_text'] || "";
                        const videoTime = fila['Video Time'] || fila['video_time'] || null;
                        const messageTime = fila['Message Time'] || fila['message_time'];
                        const authorChannelUrlRaw = fila['Author Channel URL'] || fila['author_channel_url'] || "";

                        if (!authorNameRaw) continue; 

                        // Tratamiento del prefijo '@' en el autor
                        const authorNameClean = authorNameRaw.trim();
                        const authorName = authorNameClean.startsWith('@') ? authorNameClean : `@${authorNameClean}`;

                        // URL del canal estructurada con arroba
                        const urlCanalCalculada = authorChannelUrlRaw || `https://www.youtube.com/${authorName}`;

                        // Análisis analítico y de sentimiento
                        const textoProcesadoEmojis = emoji.emojify(commentText);
                        const analitica = clasificarYSentimiento(textoProcesadoEmojis);

                        // UPSERT del Catálogo de Usuarios
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

                        // INSERCIÓN DEL COMENTARIO (Delegando 'anio_txt' a Supabase)
                        const { data: comentarioInsertado, error: errComment } = await supabase
                            .from('youtube_comments')
                            .insert([{
                                file_sequence_number: Number(contadorFila),
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
                            .select('internal_id') // Obtenemos el ID asignado para la relación posterior
                            .maybeSingle();
                                                        
                        if (errComment) {
                            console.error(`❌ Error en fila ${contadorFila}:`, errComment.message);
                            continue;
                        }

                        // INSERCIÓN DE HASHTAGS RELACIONALES PARA ANÁLISIS POSTERIOR
                        if (comentarioInsertado && analitica.hashtagsLimpios.length > 0) {
                            const insertsHashtags = analitica.hashtagsLimpios.map(tag => ({
                                comment_id: comentarioInsertado.internal_id, // Vinculación primaria
                                author_name: authorName,                       // Guardamos quién lo usó
                                hashtag: tag                                   // Texto del hashtag
                            }));
                            
                            const { error: errTags } = await supabase.from('comment_hashtags').insert(insertsHashtags);
                            if (errTags) {
                                console.warn(`⚠️ Error insertando hashtag en fila ${contadorFila}:`, errTags.message);
                            }
                        }

                        contadorFila++;
                    }

                    console.log("✅ ¡Procesamiento e ingesta de datos completada!");
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