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

// Configuración de Middlewares (CORS Corregido con corchetes y comas)
app.use(cors({
  origin: [
    'https://sensational-druid-fcbe07.netlify.app',
    'https://sensational-druid-fcbe07.netlify.app/'
  ], // <--- Verifica que tenga los corchetes [] y esta coma al final
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
app.post('/api/comments/upload-csv', upload.any(), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No se recibió ningún archivo CSV." });
        }

        const nombreArchivo = req.files[0].originalname || "";
        const esEnVivo = req.body.is_live_comment === 'true';

        // --- EXTRACCIÓN DINÁMICA DE FECHAS DESDE EL NOMBRE DEL ARCHIVO ---
        let fechaTxt = "00000000";
        let anioTxt = "0000";
        let anioMesTxt = "0000-00";

        const matchFecha = nombreArchivo.match(/20\d{6}/);
        if (matchFecha) {
            fechaTxt = matchFecha[0];                             
            anioTxt = fechaTxt.substring(0, 4);                   
            anioMesTxt = `${anioTxt}-${fechaTxt.substring(4, 6)}`; 
        }

        console.log(`📂 Procesando archivo: ${nombreArchivo} | En Vivo: ${esEnVivo}`);

        const resultadosCsv = [];
        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.files[0].buffer);

        bufferStream
            .pipe(csv())
            .on('data', (data) => resultadosCsv.push(data))
            .on('end', async () => {
                try {
                    console.log(`📊 Total de filas leídas del CSV: ${resultadosCsv.length}`);
                    let contadorFila = 1;

                    for (const fila of resultadosCsv) {
                        const authorNameRaw = fila['Author Name'] ? fila['Author Name'].trim() : "";
                        const commentText = fila['Comments Text'] || ""; 
                        const videoTime = fila['Video Time'] || null;
                        const messageTime = fila['Message Time'] || null;
                        const authorChannelUrlRaw = fila['Author Channel URL'] || "";

                        if (!authorNameRaw) {
                            console.warn(`⚠️ Fila ${contadorFila} omitida: Columna 'Author Name' vacía.`);
                            contadorFila++;
                            continue;
                        }

                        // Asegurar formato del autor con '@' si no lo trae
                        const authorName = authorNameRaw.startsWith('@') ? authorNameRaw : `@${authorNameRaw}`;

                        // Resolver URL del canal respetando el '@'
                        const urlCanalCalculada = authorChannelUrlRaw || `https://www.youtube.com/${authorName}`;

                        // Convertir emojis a texto/formato unicode nativo
                        const textoProcesadoEmojis = emoji.emojify(commentText);

                        // --- DETECCIÓN DINÁMICA DE HASHTAGS ---
                        const regexHashtags = /#\w+/g;
                        const hashtagsEncontrados = textoProcesadoEmojis.match(regexHashtags) || [];
                        // Limpiar duplicados y quitarles el símbolo '#' para guardar el texto limpio si se prefiere
                        const hashtagsLimpios = [...new Set(hashtagsEncontrados)].map(tag => tag.replace('#', ''));

                        // --- EVALUACIÓN DE SENTIMIENTO (Sentiment-Spanish) ---
                        const analisisSentimiento = sentiment.analyze(textoProcesadoEmojis);
                        let clasificacionSentimiento = 'Neutral';
                        if (analisisSentimiento.score > 0) clasificacionSentimiento = 'Positivo';
                        if (analisisSentimiento.score < 0) clasificacionSentimiento = 'Negativo';

                        // --- EVALUACIÓN DE TIPO DE COMENTARIO ---
                        let tipoComentarioCalculado = 'Solo Comentarios';
                        
                        const textoLimpioDeHashtags = textoProcesadoEmojis.replace(regexHashtags, '').trim();
                        const contieneSoloEmojis = textoProcesadoEmojis.length > 0 && emoji.strip(textoProcesadoEmojis).trim() === "";
                        const regexSaludos = /\b(hola|saludos|buenos dias|buenas tardes|buenas noches|buen dia|saludo|gracias)\b/i;

                        if (textoProcesadoEmojis.length > 0 && hashtagsEncontrados.length > 0 && textoLimpioDeHashtags === "") {
                            tipoComentarioCalculado = 'Solo HashTag';
                        } else if (contieneSoloEmojis) {
                            tipoComentarioCalculado = 'Solo Emoticons';
                        } else if (regexSaludos.test(textoProcesadoEmojis) && hashtagsEncontrados.length === 0 && !contieneSoloEmojis && textoProcesadoEmojis.length < 30) {
                            tipoComentarioCalculado = 'Solo Saludos';
                        } else if (hashtagsEncontrados.length > 0) {
                            tipoComentarioCalculado = 'Comentarios con HashTag';
                        } else {
                            tipoComentarioCalculado = 'Solo Comentarios';
                        }

                        // --- LÓGICA UPSERT DE USUARIO EN EL CATÁLOGO ---
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

                        // --- INSERCIÓN EN LA TABLA youtube_comments ---
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
                                tipo_comentario: tipoComentarioCalculado,
                                sentimiento: clasificacionSentimiento,
                                uploaded_at: new Date(),            
                                fecha_txt: fechaTxt,                
                                anio_mes_txt: anioMesTxt            
                            }])
                            .select('internal_id') // Recuperamos el ID autogenerado
                            .maybeSingle();

                        if (errComment) {
                            console.error(`❌ Error insertando fila ${contadorFila} (Autor: ${authorName}):`, errComment.message);
                            throw new Error(errComment.message);
                        }

                        // --- INSERCIÓN DE HASHTAGS EN LA TABLA RELACIONAL ---
                        if (comentarioInsertado && hashtagsLimpios.length > 0) {
                            const insertsHashtags = hashtagsLimpios.map(tag => ({
                                comment_id: comentarioInsertado.internal_id, // Relación exacta con el ID numérico de Supabase
                                author_name: authorName,                       // Guardamos quién lo realizó
                                hashtag: tag.toLowerCase()                     // Guardamos el hashtag en minúsculas para análisis estandarizado
                            }));

                            const { error: errTags } = await supabase
                                .from('comment_hashtags')
                                .insert(insertsHashtags);

                            if (errTags) {
                                console.warn(`⚠️ Advertencia al guardar hashtags de la fila ${contadorFila}:`, errTags.message);
                            }
                        }

                        contadorFila++;
                    }

                    console.log("✅ ¡Procesamiento e ingesta completados exitosamente con clasificación y hashtags!");
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

// Forzar compilacion definitiva junio 2026