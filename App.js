import "react-native-url-polyfill/auto";
import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity, Image, ActivityIndicator, ScrollView,
  StyleSheet, SafeAreaView, StatusBar, Platform, AppState, useWindowDimensions,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { decode } from "base64-arraybuffer";

// ================= Configuración (solo claves públicas) =================
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const BUCKET = "reportes";
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const CATEGORIAS = ["Equipo de cómputo", "Iluminación", "Mobiliario", "Internet", "Instalación eléctrica"];
const ESTADOS = ["Pendiente", "En proceso", "Resuelto"];
const INACTIVIDAD_MS = 15 * 60 * 1000;

// ---- Seguridad: Token en Keychain/Keystore ----
const CHUNK = 1800;
const num = async (k) => parseInt((await SecureStore.getItemAsync(k + "_n")) ?? "0", 10);
const SecureAdapter = {
  async getItem(k) {
    if (Platform.OS === "web") return AsyncStorage.getItem(k);
    const n = await num(k); if (!n) return null;
    let v = ""; for (let i = 0; i < n; i++) v += (await SecureStore.getItemAsync(`${k}_${i}`)) ?? "";
    return v;
  },
  async setItem(k, value) {
    if (Platform.OS === "web") return AsyncStorage.setItem(k, value);
    const parts = value.match(/[\s\S]{1,1800}/g) ?? [];
    for (let i = 0; i < parts.length; i++) await SecureStore.setItemAsync(`${k}_${i}`, parts[i]);
    await SecureStore.setItemAsync(k + "_n", String(parts.length));
  },
  async removeItem(k) {
    if (Platform.OS === "web") return AsyncStorage.removeItem(k);
    const n = await num(k);
    for (let i = 0; i < n; i++) await SecureStore.deleteItemAsync(`${k}_${i}`);
    await SecureStore.deleteItemAsync(k + "_n");
  },
};

const secureFetch = (url, options = {}) => {
  if (!String(url).startsWith("https://")) return Promise.reject(new Error("Conexión bloqueada: solo se permite HTTPS"));
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 20000);
  return fetch(url, { ...options, signal: options.signal ?? c.signal }).finally(() => clearTimeout(t));
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: SecureAdapter, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
  global: { fetch: secureFetch },
});

const friendly = (e) => {
  const m = e?.message ?? String(e);
  if (/network|fetch|failed to|timeout|offline|abort/i.test(m))
    return "No se pudo conectar con el servicio. Revisa tu internet e inténtalo de nuevo.";
  return m;
};
const guessMime = (uri = "") =>
  ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" })[uri.split("?")[0].split(".").pop().toLowerCase()];

// ================= Raíz =================
export default function App() {
  const [session, setSession] = useState(undefined);
  const fondo = useRef(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    const as = AppState.addEventListener("change", (st) => {
      if (st === "active") {
        supabase.auth.startAutoRefresh();
        if (fondo.current && Date.now() - fondo.current > INACTIVIDAD_MS) supabase.auth.signOut();
        fondo.current = null;
      } else {
        supabase.auth.stopAutoRefresh();
        fondo.current = Date.now();
      }
    });
    return () => { sub.subscription.unsubscribe(); as.remove(); };
  }, []);

  if (session === undefined) return <View style={[s.safe, s.centerAll]}><ActivityIndicator size="large" color="#1e293b" /></View>;
  return session ? <Principal user={session.user} /> : <Login />;
}

// ================= Autenticación =================
function Login() {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [modo, setModo] = useState("login");
  const [msg, setMsg] = useState(null);
  const [cargando, setCargando] = useState(false);
  const { width } = useWindowDimensions();

  const enviar = async () => {
    const correo = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return setMsg({ t: "error", m: "Escribe un correo válido." });
    if (!pass) return setMsg({ t: "error", m: "Escribe tu contraseña." });
    if (modo === "registro" && pass.length < 8) return setMsg({ t: "error", m: "La contraseña debe tener al menos 8 caracteres." });
    setCargando(true); setMsg(null);
    try {
      if (modo === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email: correo, password: pass });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email: correo, password: pass });
        if (error) throw error;
        if (!data.session) setMsg({ t: "ok", m: "Cuenta creada. Revisa tu correo para confirmarla y luego inicia sesión." });
      }
    } catch (e) {
      setMsg({ t: "error", m: /invalid login/i.test(e.message) ? "Correo o contraseña incorrectos." : friendly(e) });
    } finally { setCargando(false); }
  };

  const maxWidth = width > 600 ? 450 : "100%";

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={[s.container, { justifyContent: "center", flexGrow: 1 }]} keyboardShouldPersistTaps="handled">
        <View style={{ width: maxWidth, alignSelf: "center" }}>
          <Text style={[s.title, { textAlign: "center" }]}>Portal de Mantenimiento</Text>
          <Text style={[s.subtitle, { textAlign: "center", marginBottom: 24 }]}>Ingresa tus credenciales institucionales</Text>

          <View style={s.card}>
            <Text style={s.label}>CORREO ELECTRÓNICO</Text>
            <TextInput style={s.input} placeholder="usuario@universidad.edu" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />

            <Text style={s.label}>CONTRASEÑA</Text>
            <TextInput style={s.input} placeholder="••••••••" secureTextEntry value={pass} onChangeText={setPass} />

            <TouchableOpacity style={[s.btn, cargando && s.off]} onPress={enviar} disabled={cargando}>
              <Text style={s.btnText}>{cargando ? "PROCESANDO..." : (modo === "login" ? "INICIAR SESIÓN" : "CREAR CUENTA")}</Text>
            </TouchableOpacity>

            {msg && <Text style={msg.t === "ok" ? s.ok : s.error}>{msg.m}</Text>}

            <TouchableOpacity onPress={() => { setModo(modo === "login" ? "registro" : "login"); setMsg(null); }} style={{ marginTop: 20, alignItems: "center" }}>
              <Text style={s.linkText}>
                {modo === "login" ? "¿No tienes cuenta? Regístrate aquí" : "¿Ya tienes cuenta? Inicia sesión"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ================= Pantalla principal =================
function Principal({ user }) {
  const [tab, setTab] = useState("nuevo");
  const [esAdmin, setEsAdmin] = useState(false);
  const [reportes, setReportes] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [aviso, setAviso] = useState(null);
  const { width } = useWindowDimensions();
  const maxWidth = width > 768 ? 700 : "100%";

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null);
    try {
      const { data, error } = await supabase.from("reportes").select("*").order("fecha_registro", { ascending: false });
      if (error) throw error;
      const paths = data.filter((r) => r.imagen_path).map((r) => r.imagen_path);
      const urls = {};
      if (paths.length) {
        const { data: firmadas, error: e2 } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
        if (e2) throw e2;
        firmadas.forEach((f) => { if (f.signedUrl) urls[f.path] = f.signedUrl; });
      }
      setReportes(data.map((r) => ({ ...r, url: urls[r.imagen_path] })));
    } catch (e) { setAviso(friendly(e)); }
    finally { setCargando(false); }
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
      setEsAdmin(!!data);
      cargar();
    })();
  }, [user.id, cargar]);

  const cambiarEstado = async (id, estado) => {
    const { data, error } = await supabase.from("reportes").update({ estado }).eq("id", id).select();
    if (error) return setAviso(friendly(error));
    if (!data.length) return setAviso("No tienes permiso para cambiar el estado.");
    cargar();
  };

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" />

      {/* Header */}
      <View style={[s.header, { width: maxWidth, alignSelf: "center", width: '100%', maxWidth: 700, paddingHorizontal: 20 }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>Gestión de Reportes</Text>
          <Text style={s.headerSub}>{user.email} {esAdmin && <Text style={{ fontWeight: 'bold', color: '#2563eb' }}>· Administrador</Text>}</Text>
        </View>
        <TouchableOpacity onPress={() => supabase.auth.signOut()} style={s.logoutBtn}>
          <Text style={s.logoutText}>Salir</Text>
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View style={[s.tabsContainer, { width: maxWidth, alignSelf: "center", width: '100%', maxWidth: 700 }]}>
        {[["nuevo", "Nuevo Reporte"], ["lista", esAdmin ? "Todos los Reportes" : "Mis Reportes"], ["pruebas", "Seguridad"]].map(([k, t]) => (
          <TouchableOpacity key={k} style={[s.tab, tab === k && s.tabOn]} onPress={() => setTab(k)}>
            <Text style={[s.tabText, tab === k && s.tabTextOn]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={[s.scrollContainer, { width: maxWidth, alignSelf: "center", width: '100%', maxWidth: 700 }]}>
        {tab === "nuevo" && <Nuevo user={user} onCreado={() => { cargar(); setTab("lista"); }} />}
        {tab === "lista" && <Lista reportes={reportes} cargando={cargando} aviso={aviso} esAdmin={esAdmin} onRefresh={cargar} onEstado={cambiarEstado} />}
        {tab === "pruebas" && <Pruebas user={user} reportes={reportes} />}
      </ScrollView>
    </SafeAreaView>
  );
}

// ================= Registro de reporte =================
function Nuevo({ user, onCreado }) {
  const [categoria, setCategoria] = useState(null);
  const [ubicacion, setUbicacion] = useState("");
  const [coords, setCoords] = useState(null);
  const [descripcion, setDescripcion] = useState("");
  const [imagen, setImagen] = useState(null);
  const [estado, setEstado] = useState({ t: "idle", m: "" });

  const gps = async () => {
    try {
      const p = await Location.requestForegroundPermissionsAsync();
      if (!p.granted) return setEstado({ t: "error", m: "Permiso de ubicación denegado." });
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
    } catch (e) { setEstado({ t: "error", m: "No se pudo obtener la ubicación." }); }
  };

  const elegir = async (fuente) => {
    try {
      const p = fuente === "camara" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!p.granted) return setEstado({ t: "error", m: "Permiso denegado para " + (fuente === "camara" ? "la cámara." : "la galería.") });
      const opts = { mediaTypes: ["images"], quality: 0.6, base64: true };
      const r = fuente === "camara" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (!r.canceled) { setImagen(r.assets[0]); setEstado({ t: "idle", m: "" }); }
    } catch (e) { setEstado({ t: "error", m: friendly(e) }); }
  };

  const validar = () => {
    if (!categoria) throw new Error("Selecciona una categoría.");
    if (ubicacion.trim().length < 3) throw new Error("Indica la ubicación.");
    const d = descripcion.trim();
    if (d.length < 10) throw new Error("La descripción debe tener al menos 10 caracteres.");
    if (d.length > 500) throw new Error("La descripción no puede pasar de 500 caracteres.");
    if (!imagen) return null;
    const mime = imagen.mimeType ?? guessMime(imagen.uri);
    if (!ALLOWED[mime]) throw new Error(`Formato no permitido (${mime ?? "desconocido"}). Usa JPG, PNG o WebP.`);
    const bytes = imagen.fileSize ?? Math.floor(((imagen.base64?.length ?? 0) * 3) / 4);
    if (bytes > MAX_BYTES) throw new Error("La foto pesa más de 5 MB.");
    return { mime, ext: ALLOWED[mime], bytes };
  };

  const enviar = async () => {
    let subido = null;
    try {
      const foto = validar();
      setEstado({ t: "loading", m: "Enviando reporte..." });
      const fila = { categoria, ubicacion: ubicacion.trim(), descripcion: descripcion.trim(), latitud: coords?.lat ?? null, longitud: coords?.lon ?? null };
      if (foto) {
        const path = `${user.id}/${Date.now()}.${foto.ext}`;
        const { error } = await supabase.storage.from(BUCKET).upload(path, decode(imagen.base64), { contentType: foto.mime, upsert: false });
        if (error) throw error;
        subido = path; fila.imagen_path = path;
      }
      const { error } = await supabase.from("reportes").insert(fila);
      if (error) throw error;
      setEstado({ t: "ok", m: "Reporte registrado exitosamente." });
      setCategoria(null); setUbicacion(""); setCoords(null); setDescripcion(""); setImagen(null);
      onCreado();
    } catch (e) {
      if (subido) supabase.storage.from(BUCKET).remove([subido]).catch(() => { });
      setEstado({ t: "error", m: friendly(e) });
    }
  };

  const ocupado = estado.t === "loading";

  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>Detalles de la Incidencia</Text>

      <Text style={s.label}>CATEGORÍA DEL PROBLEMA</Text>
      <View style={s.chips}>
        {CATEGORIAS.map((c) => (
          <TouchableOpacity key={c} style={[s.chip, categoria === c && s.chipOn]} onPress={() => setCategoria(c)}>
            <Text style={[s.chipText, categoria === c && s.chipTextOn]}>{c}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={s.label}>UBICACIÓN</Text>
      <TextInput style={s.input} placeholder="Ej. Edificio B, salón 204" value={ubicacion} onChangeText={setUbicacion} maxLength={120} />

      <TouchableOpacity style={s.btnSecondary} onPress={gps}>
        <Text style={s.btnSecondaryText}>Adjuntar coordenadas GPS</Text>
      </TouchableOpacity>
      {coords && <Text style={s.smallText}>Lat: {coords.lat.toFixed(5)} | Lon: {coords.lon.toFixed(5)}</Text>}

      <Text style={s.label}>DESCRIPCIÓN DEL PROBLEMA ({descripcion.trim().length}/500)</Text>
      <TextInput style={[s.input, { height: 100, textAlignVertical: "top" }]} multiline placeholder="Proporciona detalles claros sobre lo ocurrido..." value={descripcion} onChangeText={setDescripcion} maxLength={500} />

      <Text style={s.label}>EVIDENCIA FOTOGRÁFICA (OPCIONAL)</Text>
      <View style={s.row}>
        <TouchableOpacity style={s.btnSecondaryHalf} onPress={() => elegir("galeria")}><Text style={s.btnSecondaryText}>Seleccionar de Galería</Text></TouchableOpacity>
        <TouchableOpacity style={s.btnSecondaryHalf} onPress={() => elegir("camara")}><Text style={s.btnSecondaryText}>Tomar Fotografía</Text></TouchableOpacity>
      </View>
      {imagen && <Image source={{ uri: imagen.uri }} style={s.preview} />}

      <TouchableOpacity style={[s.btn, ocupado && s.off]} onPress={enviar} disabled={ocupado}>
        <Text style={s.btnText}>{ocupado ? "ENVIANDO..." : "REGISTRAR REPORTE"}</Text>
      </TouchableOpacity>

      {ocupado && <ActivityIndicator color="#1e293b" style={{ marginTop: 15 }} />}
      {estado.t === "ok" && <Text style={s.msgOk}>{estado.m}</Text>}
      {estado.t === "error" && <Text style={s.msgError}>{estado.m}</Text>}
    </View>
  );
}

// ================= Consulta de reportes =================
function Lista({ reportes, cargando, aviso, esAdmin, onRefresh, onEstado }) {
  return (
    <View>
      <View style={[s.rowBetween, { marginBottom: 12 }]}>
        <Text style={s.sectionTitle}>{esAdmin ? "Todos los Reportes" : "Historial de Reportes"} ({reportes.length})</Text>
        <TouchableOpacity onPress={onRefresh}><Text style={s.linkText}>Actualizar</Text></TouchableOpacity>
      </View>

      {cargando && <ActivityIndicator style={{ marginVertical: 20 }} color="#1e293b" />}

      {aviso && (
        <View style={s.cardError}>
          <Text style={s.msgError}>{aviso}</Text>
          <TouchableOpacity onPress={onRefresh}><Text style={s.linkText}>Reintentar</Text></TouchableOpacity>
        </View>
      )}

      {!cargando && !aviso && reportes.length === 0 && (
        <View style={s.emptyState}><Text style={s.smallText}>No hay reportes registrados.</Text></View>
      )}

      {reportes.map((r) => (
        <View key={r.id} style={s.cardReport}>
          <View style={s.rowBetween}>
            <Text style={s.cardReportTitle}>{r.categoria}</Text>
            <Text style={[s.badge, r.estado === "Resuelto" ? s.bOk : r.estado === "En proceso" ? s.bWarn : s.bPend]}>{r.estado}</Text>
          </View>

          <Text style={s.textBold}>Ubicación: <Text style={s.textNormal}>{r.ubicacion}</Text></Text>
          <Text style={[s.textNormal, { marginTop: 6, marginBottom: 10 }]}>{r.descripcion}</Text>

          {r.url ? <Image source={{ uri: r.url }} style={s.previewReport} /> : r.imagen_path ? <Text style={s.smallText}>Imagen no disponible</Text> : null}

          <View style={[s.rowBetween, { marginTop: 12, borderTopWidth: 1, borderTopColor: "#f1f5f9", paddingTop: 10 }]}>
            <Text style={s.smallText}>{new Date(r.fecha_registro).toLocaleString("es-MX")}</Text>
            {esAdmin && <Text style={s.smallText}>ID: {r.user_id.slice(0, 8)}</Text>}
          </View>

          {esAdmin && (
            <View style={s.adminActions}>
              <Text style={s.smallText}>Cambiar estado:</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                {ESTADOS.map((e) => (
                  <TouchableOpacity key={e} style={[s.chipSmall, r.estado === e && s.chipOn]} onPress={() => onEstado(r.id, e)}>
                    <Text style={[s.chipTextSmall, r.estado === e && s.chipTextOn]}>{e}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

// ================= Pruebas de seguridad =================
function Pruebas({ user, reportes }) {
  const [idAjeno, setIdAjeno] = useState("");
  const [rutaAjena, setRutaAjena] = useState("");
  const [out, setOut] = useState("");

  const pAjeno = async () => {
    if (!idAjeno.trim()) return setOut("Pega el ID de un reporte de OTRO usuario.");
    const { data, error } = await supabase.from("reportes").select("*").eq("id", idAjeno.trim());
    setOut(error ? "Error: " + friendly(error) : data.length === 0
      ? "APROBADO: Acceso DENEGADO (la consulta devolvió 0 resultados)."
      : "FALLO: Se obtuvo el reporte. Revisa las políticas RLS o verifica que no seas administrador.");
  };
  const pArchivoAjeno = async () => {
    if (!rutaAjena.trim()) return setOut("Pega la ruta de una foto de OTRO usuario (uid/archivo.jpg).");
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(rutaAjena.trim(), 60);
    setOut(error || !data?.signedUrl ? `APROBADO: Acceso DENEGADO al archivo.` : "FALLO: Se generó una URL para un archivo ajeno. Revisa las políticas.");
  };
  const pFormato = async () => {
    const { error } = await supabase.storage.from(BUCKET).upload(`${user.id}/prueba_${Date.now()}.txt`, decode("aG9sYQ=="), { contentType: "text/plain" });
    setOut(error ? `APROBADO: El servidor RECHAZÓ el archivo .txt.` : "FALLO: El archivo fue aceptado. Revisa el bucket.");
  };
  const pSinSesion = async () => {
    const r = reportes.find((x) => x.imagen_path);
    if (!r) return setOut("Primero registra un reporte con foto.");
    const h = { apikey: SUPABASE_KEY };
    const urls = [`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${r.imagen_path}`, `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${r.imagen_path}`];
    const res = [];
    for (const u of urls) {
      try { const x = await fetch(u, { headers: h }); res.push(`HTTP ${x.status} · ${u.includes("/public/") ? "URL pública" : "URL privada sin sesión"}`); }
      catch (e) { res.push(friendly(e)); }
    }
    setOut("Acceso sin autorización:\n" + res.join("\n") + "\n(Esperado: 400/403/404, nunca 200)");
  };
  const pHttp = async () => {
    try { await secureFetch("http://example.com"); setOut("FALLO: Se permitió HTTP."); }
    catch (e) { setOut("APROBADO: " + e.message); }
  };

  return (
    <View>
      <View style={s.cardSecurity}>
        <Text style={s.securityTitle}>Pruebas de Aislamiento de Datos (P5)</Text>
        <Text style={s.smallText}>Verifica que un usuario no pueda acceder a reportes o fotos de otros.</Text>

        <TextInput style={[s.input, { marginTop: 12 }]} placeholder="ID de reporte ajeno" autoCapitalize="none" value={idAjeno} onChangeText={setIdAjeno} />
        <TouchableOpacity style={s.btnSecondaryDark} onPress={pAjeno}><Text style={s.btnSecondaryDarkText}>Consultar reporte ajeno</Text></TouchableOpacity>

        <TextInput style={[s.input, { marginTop: 12 }]} placeholder="Ruta de foto ajena (uid/archivo.jpg)" autoCapitalize="none" value={rutaAjena} onChangeText={setRutaAjena} />
        <TouchableOpacity style={s.btnSecondaryDark} onPress={pArchivoAjeno}><Text style={s.btnSecondaryDarkText}>Solicitar URL de foto ajena</Text></TouchableOpacity>
      </View>

      <View style={s.cardSecurity}>
        <Text style={s.securityTitle}>Validación de Archivos y Red (P6, P7)</Text>

        <TouchableOpacity style={[s.btnSecondaryDark, { marginTop: 10 }]} onPress={pFormato}><Text style={s.btnSecondaryDarkText}>Subir archivo .txt (bloqueo de formato)</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btnSecondaryDark, { marginTop: 10 }]} onPress={pSinSesion}><Text style={s.btnSecondaryDarkText}>Intentar acceder a foto sin sesión</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btnSecondaryDark, { marginTop: 10 }]} onPress={pHttp}><Text style={s.btnSecondaryDarkText}>Intentar petición HTTP (sin cifrar)</Text></TouchableOpacity>

        <Text style={[s.smallText, { marginTop: 16, fontStyle: 'italic' }]}>Nota P6: Activa el modo avión y trata de enviar un reporte.</Text>
      </View>

      {!!out && (
        <View style={s.logContainer}>
          <Text style={s.logTitle}>Resultado de la prueba:</Text>
          <Text style={s.logText}>{out}</Text>
        </View>
      )}
    </View>
  );
}

// ================= Estilos =================
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f1f5f9" },
  centerAll: { alignItems: "center", justifyContent: "center" },
  container: { padding: 20 },
  scrollContainer: { padding: 20, paddingBottom: 60 },

  // Header
  header: { flexDirection: "row", alignItems: "center", paddingTop: Platform.OS === "android" ? 40 : 10, paddingBottom: 15, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  headerTitle: { fontSize: 20, fontWeight: "800", color: "#0f172a", letterSpacing: -0.5 },
  headerSub: { fontSize: 13, color: "#64748b", marginTop: 2 },
  logoutBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: "#f1f5f9" },
  logoutText: { color: "#ef4444", fontWeight: "700", fontSize: 13 },

  // Tabs
  tabsContainer: { flexDirection: "row", paddingHorizontal: 20, paddingVertical: 12, gap: 10, backgroundColor: "#f1f5f9" },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: "#e2e8f0", alignItems: "center" },
  tabOn: { backgroundColor: "#1e293b" },
  tabText: { fontWeight: "700", color: "#475569", fontSize: 13 },
  tabTextOn: { color: "#ffffff" },

  // Tipografía General
  title: { fontSize: 28, fontWeight: "800", color: "#0f172a", letterSpacing: -0.5 },
  subtitle: { fontSize: 15, color: "#64748b", fontWeight: "500" },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: "#0f172a" },
  label: { fontSize: 11, fontWeight: "700", color: "#475569", marginTop: 16, marginBottom: 6, letterSpacing: 0.5 },
  textBold: { fontSize: 14, fontWeight: "700", color: "#0f172a" },
  textNormal: { fontSize: 14, color: "#334155", lineHeight: 20 },
  smallText: { fontSize: 12, color: "#64748b", marginTop: 4 },

  // Tarjetas y Contenedores
  card: { backgroundColor: "#ffffff", borderRadius: 12, padding: 20, borderWidth: 1, borderColor: "#e2e8f0" },
  cardTitle: { fontSize: 18, fontWeight: "800", color: "#0f172a", marginBottom: 4 },
  cardReport: { backgroundColor: "#ffffff", borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: "#e2e8f0" },
  cardReportTitle: { fontSize: 15, fontWeight: "700", color: "#0f172a", flex: 1, marginRight: 10 },
  cardError: { backgroundColor: "#fef2f2", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#fecaca" },
  emptyState: { padding: 30, alignItems: "center", backgroundColor: "#ffffff", borderRadius: 12, borderStyle: "dashed", borderWidth: 1, borderColor: "#cbd5e1" },

  // Inputs
  input: { backgroundColor: "#f8fafc", borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 14, fontSize: 15, color: "#1e293b" },

  // Botones
  btn: { backgroundColor: "#1e293b", padding: 16, borderRadius: 8, alignItems: "center", marginTop: 24 },
  btnText: { color: "#ffffff", fontWeight: "700", fontSize: 14, letterSpacing: 0.5 },
  off: { opacity: 0.6 },
  btnSecondary: { backgroundColor: "#f1f5f9", borderWidth: 1, borderColor: "#e2e8f0", padding: 12, borderRadius: 8, alignItems: "center", marginTop: 8 },
  btnSecondaryHalf: { flex: 1, backgroundColor: "#f1f5f9", borderWidth: 1, borderColor: "#e2e8f0", padding: 14, borderRadius: 8, alignItems: "center" },
  btnSecondaryText: { color: "#334155", fontWeight: "600", fontSize: 13 },

  // Chips (Categorías / Estados)
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: "#f1f5f9", borderWidth: 1, borderColor: "#e2e8f0" },
  chipOn: { backgroundColor: "#1e293b", borderColor: "#1e293b" },
  chipText: { color: "#475569", fontWeight: "600", fontSize: 13 },
  chipTextOn: { color: "#ffffff" },
  chipSmall: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: "#f1f5f9", borderWidth: 1, borderColor: "#e2e8f0" },
  chipTextSmall: { color: "#475569", fontWeight: "600", fontSize: 11 },

  // Badges (Estados de Reporte)
  badge: { fontSize: 11, fontWeight: "700", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, overflow: "hidden", textTransform: "uppercase" },
  bPend: { backgroundColor: "#fee2e2", color: "#b91c1c" },
  bWarn: { backgroundColor: "#fef3c7", color: "#b45309" },
  bOk: { backgroundColor: "#dcfce7", color: "#15803d" },

  // Imágenes
  preview: { width: "100%", height: 200, borderRadius: 8, marginTop: 12, backgroundColor: "#e2e8f0", resizeMode: 'cover' },
  previewReport: { width: "100%", height: 160, borderRadius: 8, marginTop: 10, backgroundColor: "#f1f5f9", resizeMode: 'cover' },

  // Layout Auxiliar
  row: { flexDirection: "row", gap: 10 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },

  // Mensajes
  msgOk: { color: "#059669", marginTop: 16, fontWeight: "600", fontSize: 14, textAlign: "center" },
  msgError: { color: "#dc2626", marginTop: 16, fontWeight: "600", fontSize: 14, textAlign: "center" },
  linkText: { color: "#2563eb", fontWeight: "600", fontSize: 14 },

  // Admin Actions
  adminActions: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#f1f5f9" },

  // Pruebas
  cardSecurity: { backgroundColor: "#fffbeb", borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: "#fde68a" },
  securityTitle: { fontSize: 16, fontWeight: "700", color: "#92400e", marginBottom: 4 },
  btnSecondaryDark: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#fcd34d", padding: 12, borderRadius: 8, alignItems: "center", marginTop: 10 },
  btnSecondaryDarkText: { color: "#92400e", fontWeight: "700", fontSize: 13 },
  logContainer: { backgroundColor: "#1e293b", padding: 16, borderRadius: 8, marginTop: 12 },
  logTitle: { color: "#94a3b8", fontSize: 11, fontWeight: "700", marginBottom: 8, textTransform: "uppercase" },
  logText: { color: "#f8fafc", fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontSize: 13, lineHeight: 20 },
});