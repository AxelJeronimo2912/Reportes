import "react-native-url-polyfill/auto";
import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  View, Text, TextInput, TouchableOpacity, Image, ActivityIndicator, ScrollView,
  StyleSheet, SafeAreaView, StatusBar, Platform, AppState, useWindowDimensions, Linking,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { decode } from "base64-arraybuffer";

// ================= Configuración =================
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const BUCKET = "reportes";
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const CATEGORIAS = ["Equipo de cómputo", "Iluminación", "Mobiliario", "Internet", "Instalación eléctrica"];
const ESTADOS = ["Pendiente", "En proceso", "Resuelto"];
const INACTIVIDAD_MS = 15 * 60 * 1000;

// ---- Seguridad: Token en Keychain/Keystore ----
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

// ================= Hook de responsividad =================
function useResponsive() {
  const { width, height } = useWindowDimensions();
  return useMemo(() => {
    const isSmall = width < 360;
    const isMobile = width < 600;
    const isTablet = width >= 600 && width < 1024;
    const isLarge = width >= 1024;
    const isLandscape = width > height;

    const maxContent = isLarge ? 1000 : isTablet ? 800 : width - 32;
    const pad = isSmall ? 12 : isMobile ? 16 : 24;
    const gap = isSmall ? 6 : 10;

    // Columnas para la lista de reportes
    const listCols = isTablet || isLarge ? 2 : 1;

    // Tamaños de fuente escalados
    const fs = {
      title: isSmall ? 22 : isTablet ? 32 : 28,
      subtitle: isSmall ? 13 : 15,
      headerTitle: isSmall ? 16 : isTablet ? 22 : 20,
      headerSub: isSmall ? 11 : 13,
      sectionTitle: isSmall ? 15 : isTablet ? 20 : 18,
      label: isSmall ? 10 : 11,
      body: isSmall ? 13 : 14,
      small: isSmall ? 11 : 12,
      btn: isSmall ? 12 : 14,
      chip: isSmall ? 11 : 13,
    };

    return { width, height, isSmall, isMobile, isTablet, isLarge, isLandscape, maxContent, pad, gap, listCols, fs };
  }, [width, height]);
}

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
  const r = useResponsive();

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

  const cardWidth = r.isLarge ? 480 : r.isTablet ? 440 : "100%";

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" />
      <ScrollView
        contentContainerStyle={[s.container, { padding: r.pad, justifyContent: "center", flexGrow: 1 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ width: cardWidth, alignSelf: "center" }}>
          <Text style={[s.title, { textAlign: "center", fontSize: r.fs.title }]}>Portal de Mantenimiento</Text>
          <Text style={[s.subtitle, { textAlign: "center", marginBottom: 24, fontSize: r.fs.subtitle }]}>
            Ingresa tus credenciales institucionales
          </Text>

          <View style={[s.card, { padding: r.isSmall ? 16 : 20 }]}>
            <Text style={[s.label, { fontSize: r.fs.label }]}>CORREO ELECTRÓNICO</Text>
            <TextInput
              style={s.input}
              placeholder="usuario@universidad.edu"
              autoCapitalize="none"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />

            <Text style={[s.label, { fontSize: r.fs.label }]}>CONTRASEÑA</Text>
            <TextInput style={s.input} placeholder="••••••••" secureTextEntry value={pass} onChangeText={setPass} />

            <TouchableOpacity style={[s.btn, cargando && s.off]} onPress={enviar} disabled={cargando}>
              <Text style={[s.btnText, { fontSize: r.fs.btn }]}>
                {cargando ? "PROCESANDO..." : (modo === "login" ? "INICIAR SESIÓN" : "CREAR CUENTA")}
              </Text>
            </TouchableOpacity>

            {msg && <Text style={msg.t === "ok" ? s.msgOk : s.msgError}>{msg.m}</Text>}

            <TouchableOpacity
              onPress={() => { setModo(modo === "login" ? "registro" : "login"); setMsg(null); }}
              style={{ marginTop: 20, alignItems: "center" }}
            >
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
  const [okMsg, setOkMsg] = useState(null);
  const [verAislamiento, setVerAislamiento] = useState(false);
  const r = useResponsive();

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

  const alCrear = () => {
    cargar();
    setTab("lista");
    setOkMsg("Reporte registrado exitosamente.");
    setTimeout(() => setOkMsg(null), 6000);
  };

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" />

      {/* Header responsivo */}
      <View style={[s.header, { paddingHorizontal: r.pad, paddingTop: Platform.OS === "android" ? 40 : 10 }]}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text style={[s.headerTitle, { fontSize: r.fs.headerTitle }]} numberOfLines={1}>Gestión de Reportes</Text>
          <Text style={[s.headerSub, { fontSize: r.fs.headerSub }]} numberOfLines={1}>
            {user.email}{" "}
            {esAdmin && <Text style={{ fontWeight: "bold", color: "#2563eb" }}>· Administrador</Text>}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: r.gap }}>
          <TouchableOpacity
            onPress={() => setVerAislamiento(true)}
            style={[s.logoutBtn, { backgroundColor: "#e0f2fe", paddingHorizontal: r.isSmall ? 8 : 12 }]}
          >
            <Text style={[s.logoutText, { color: "#0369a1", fontSize: r.isSmall ? 11 : 13 }]}>
              Aislamiento
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => supabase.auth.signOut()} style={[s.logoutBtn, { paddingHorizontal: r.isSmall ? 8 : 12 }]}>
            <Text style={[s.logoutText, { fontSize: r.isSmall ? 11 : 13 }]}>Salir</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Tabs responsivos */}
      <View style={[s.tabsContainer, { paddingHorizontal: r.pad, gap: r.gap }]}>
        {[["nuevo", "Nuevo Reporte"], ["lista", esAdmin ? "Todos los Reportes" : "Mis Reportes"]].map(([k, t]) => (
          <TouchableOpacity key={k} style={[s.tab, tab === k && s.tabOn]} onPress={() => setTab(k)}>
            <Text
              style={[s.tabText, tab === k && s.tabTextOn, { fontSize: r.fs.btn }]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {t}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={[s.scrollContainer, { padding: r.pad, paddingBottom: 60 }]}
        keyboardShouldPersistTaps="handled"
      >
        {okMsg && <Text style={[s.msgOk, { marginTop: 0, marginBottom: 12 }]}>{okMsg}</Text>}
        {tab === "nuevo" && <Nuevo user={user} onCreado={alCrear} responsive={r} />}
        {tab === "lista" && (
          <Lista
            reportes={reportes}
            cargando={cargando}
            aviso={aviso}
            esAdmin={esAdmin}
            onRefresh={cargar}
            onEstado={cambiarEstado}
            responsive={r}
          />
        )}
      </ScrollView>

      {/* Modal de aislamiento responsivo */}
      {verAislamiento && (
        <View style={s.overlay}>
          <View
            style={[
              s.modalBox,
              {
                width: r.isLarge ? 600 : r.isTablet ? 540 : "92%",
                maxHeight: r.height * 0.85,
                padding: r.isSmall ? 14 : 18,
              },
            ]}
          >
            <View style={s.rowBetween}>
              <Text style={[s.securityTitle, { fontSize: r.isSmall ? 15 : 16 }]}>Aislamiento de Datos</Text>
              <TouchableOpacity onPress={() => setVerAislamiento(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={{ color: "#92400e", fontWeight: "700", fontSize: 18 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={s.smallText}>Verifica que un usuario no pueda acceder a reportes o fotos de otros.</Text>
              <Aislamiento user={user} responsive={r} />
            </ScrollView>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

// ================= Registro de reporte =================
function Nuevo({ user, onCreado, responsive: r }) {
  const [categoria, setCategoria] = useState(null);
  const [ubicacion, setUbicacion] = useState("");
  const [coords, setCoords] = useState(null);
  const [descripcion, setDescripcion] = useState("");
  const [imagen, setImagen] = useState(null);
  const [estado, setEstado] = useState({ t: "idle", m: "" });
  const [ajustes, setAjustes] = useState(false);

  const gps = async () => {
    try {
      const p = await Location.requestForegroundPermissionsAsync();
      if (!p.granted) {
        setAjustes(!p.canAskAgain);
        return setEstado({ t: "error", m: "Permiso de ubicación denegado. Puedes escribir la ubicación manualmente." });
      }
      setAjustes(false);
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      setEstado({ t: "idle", m: "" });
    } catch (e) { setEstado({ t: "error", m: "No se pudo obtener la ubicación." }); }
  };

  const elegir = async (fuente) => {
    try {
      if (fuente === "camara") {
        const p = await ImagePicker.requestCameraPermissionsAsync();
        if (!p.granted) {
          setAjustes(!p.canAskAgain);
          return setEstado({ t: "error", m: "Permiso de cámara denegado. Puedes adjuntar una foto desde la galería." });
        }
      }
      setAjustes(false);
      const opts = { mediaTypes: ["images"], quality: 0.6, base64: true };
      const res = fuente === "camara" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (!res.canceled) { setImagen(res.assets[0]); setEstado({ t: "idle", m: "" }); }
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
      const fila = {
        categoria, ubicacion: ubicacion.trim(), descripcion: descripcion.trim(),
        latitud: coords?.lat ?? null, longitud: coords?.lon ?? null,
      };
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
    <View style={[s.card, { padding: r.isSmall ? 14 : 20 }]}>
      <Text style={[s.cardTitle, { fontSize: r.isSmall ? 16 : 18 }]}>Detalles de la Incidencia</Text>

      <Text style={[s.label, { fontSize: r.fs.label }]}>CATEGORÍA DEL PROBLEMA</Text>
      <View style={[s.chips, { gap: r.gap }]}>
        {CATEGORIAS.map((c) => (
          <TouchableOpacity key={c} style={[s.chip, categoria === c && s.chipOn]} onPress={() => setCategoria(c)}>
            <Text style={[s.chipText, categoria === c && s.chipTextOn, { fontSize: r.fs.chip }]}>{c}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={[s.label, { fontSize: r.fs.label }]}>UBICACIÓN</Text>
      <TextInput
        style={[s.input, { fontSize: r.fs.body }]}
        placeholder="Ej. Edificio B, salón 204"
        value={ubicacion}
        onChangeText={setUbicacion}
        maxLength={120}
      />

      <TouchableOpacity style={s.btnSecondary} onPress={gps}>
        <Text style={[s.btnSecondaryText, { fontSize: r.fs.btn }]}>Adjuntar coordenadas GPS</Text>
      </TouchableOpacity>
      {coords && <Text style={s.smallText}>Lat: {coords.lat.toFixed(5)} | Lon: {coords.lon.toFixed(5)}</Text>}

      <Text style={[s.label, { fontSize: r.fs.label }]}>
        DESCRIPCIÓN DEL PROBLEMA ({descripcion.trim().length}/500)
      </Text>
      <TextInput
        style={[s.input, { height: r.isSmall ? 90 : 100, textAlignVertical: "top", fontSize: r.fs.body }]}
        multiline
        placeholder="Proporciona detalles claros sobre lo ocurrido..."
        value={descripcion}
        onChangeText={setDescripcion}
        maxLength={500}
      />

      <Text style={[s.label, { fontSize: r.fs.label }]}>EVIDENCIA FOTOGRÁFICA (OPCIONAL)</Text>
      <View style={[s.row, { gap: r.gap }]}>
        <TouchableOpacity style={s.btnSecondaryHalf} onPress={() => elegir("galeria")}>
          <Text style={[s.btnSecondaryText, { fontSize: r.fs.btn, textAlign: "center" }]} adjustsFontSizeToFit numberOfLines={2}>
            Seleccionar de Galería
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnSecondaryHalf} onPress={() => elegir("camara")}>
          <Text style={[s.btnSecondaryText, { fontSize: r.fs.btn, textAlign: "center" }]} adjustsFontSizeToFit numberOfLines={2}>
            Tomar Fotografía
          </Text>
        </TouchableOpacity>
      </View>
      {imagen && <Image source={{ uri: imagen.uri }} style={[s.preview, { height: r.isSmall ? 160 : 200 }]} />}

      <TouchableOpacity style={[s.btn, ocupado && s.off]} onPress={enviar} disabled={ocupado}>
        <Text style={[s.btnText, { fontSize: r.fs.btn }]}>{ocupado ? "ENVIANDO..." : "REGISTRAR REPORTE"}</Text>
      </TouchableOpacity>

      {ocupado && <ActivityIndicator color="#1e293b" style={{ marginTop: 15 }} />}
      {estado.t === "ok" && <Text style={s.msgOk}>{estado.m}</Text>}
      {estado.t === "error" && <Text style={s.msgError}>{estado.m}</Text>}
      {ajustes && (
        <TouchableOpacity onPress={() => Linking.openSettings()} style={{ alignItems: "center", marginTop: 8 }}>
          <Text style={s.linkText}>Abrir ajustes de la aplicación</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ================= Consulta de reportes (grid responsivo) =================
function Lista({ reportes, cargando, aviso, esAdmin, onRefresh, onEstado, responsive: r }) {
  return (
    <View>
      <View style={[s.rowBetween, { marginBottom: 12, flexWrap: "wrap", gap: 8 }]}>
        <Text style={[s.sectionTitle, { fontSize: r.fs.sectionTitle, flexShrink: 1 }]}>
          {esAdmin ? "Todos los Reportes" : "Historial de Reportes"} ({reportes.length})
        </Text>
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

      {/* Grid: 1 columna en móvil, 2 en tablet/desktop */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: r.gap * 1.2 }}>
        {reportes.map((rep) => (
          <View
            key={rep.id}
            style={[
              s.cardReport,
              r.listCols === 2 && { width: `calc(50% - ${r.gap * 0.6}px)` },
            ]}
          >
            <View style={s.rowBetween}>
              <Text style={[s.cardReportTitle, { fontSize: r.isSmall ? 13 : 15 }]} numberOfLines={2}>
                {rep.categoria}
              </Text>
              <Text
                style={[
                  s.badge,
                  rep.estado === "Resuelto" ? s.bOk : rep.estado === "En proceso" ? s.bWarn : s.bPend,
                  { fontSize: r.isSmall ? 10 : 11 },
                ]}
              >
                {rep.estado}
              </Text>
            </View>

            <Text style={[s.textBold, { fontSize: r.fs.body }]}>
              Ubicación: <Text style={s.textNormal}>{rep.ubicacion}</Text>
            </Text>
            <Text style={[s.textNormal, { marginTop: 6, marginBottom: 10, fontSize: r.fs.body }]}>
              {rep.descripcion}
            </Text>

            {rep.url
              ? <Image source={{ uri: rep.url }} style={[s.previewReport, { height: r.isSmall ? 130 : 160 }]} />
              : rep.imagen_path
                ? <Text style={s.smallText}>Imagen no disponible</Text>
                : null}

            <View style={[s.rowBetween, { marginTop: 12, borderTopWidth: 1, borderTopColor: "#f1f5f9", paddingTop: 10, flexWrap: "wrap", gap: 4 }]}>
              <Text style={s.smallText}>{new Date(rep.fecha_registro).toLocaleString("es-MX")}</Text>
              {esAdmin && <Text style={s.smallText}>ID: {rep.user_id.slice(0, 8)}</Text>}
            </View>

            {esAdmin && (
              <View style={s.adminActions}>
                <Text style={s.smallText}>Cambiar estado:</Text>
                <View style={{ flexDirection: "row", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                  {ESTADOS.map((e) => (
                    <TouchableOpacity
                      key={e}
                      style={[s.chipSmall, rep.estado === e && s.chipOn]}
                      onPress={() => onEstado(rep.id, e)}
                    >
                      <Text style={[s.chipTextSmall, rep.estado === e && s.chipTextOn]}>{e}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

// ================= Aislamiento de Datos =================
function Aislamiento({ user, responsive: r }) {
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
    setOut(error || !data?.signedUrl
      ? "APROBADO: Acceso DENEGADO al archivo."
      : "FALLO: Se generó una URL para un archivo ajeno. Revisa las políticas.");
  };

  return (
    <View>
      <TextInput
        style={[s.input, { marginTop: 12, fontSize: r.fs.body }]}
        placeholder="ID de reporte ajeno"
        autoCapitalize="none"
        value={idAjeno}
        onChangeText={setIdAjeno}
      />
      <TouchableOpacity style={s.btnSecondaryDark} onPress={pAjeno}>
        <Text style={s.btnSecondaryDarkText}>Consultar reporte ajeno</Text>
      </TouchableOpacity>

      <TextInput
        style={[s.input, { marginTop: 12, fontSize: r.fs.body }]}
        placeholder="Ruta de foto ajena (uid/archivo.jpg)"
        autoCapitalize="none"
        value={rutaAjena}
        onChangeText={setRutaAjena}
      />
      <TouchableOpacity style={s.btnSecondaryDark} onPress={pArchivoAjeno}>
        <Text style={s.btnSecondaryDarkText}>Solicitar URL de foto ajena</Text>
      </TouchableOpacity>

      {!!out && (
        <View style={s.logContainer}>
          <Text style={s.logTitle}>Resultado:</Text>
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

  overlay: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(15,23,42,0.6)", justifyContent: "center", alignItems: "center",
    padding: 16, zIndex: 1000,
  },
  modalBox: {
    backgroundColor: "#fffbeb", borderRadius: 12, borderWidth: 1, borderColor: "#fde68a",
  },

  header: {
    flexDirection: "row", alignItems: "center", paddingBottom: 15,
    backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e2e8f0",
  },
  headerTitle: { fontWeight: "800", color: "#0f172a", letterSpacing: -0.5 },
  headerSub: { color: "#64748b", marginTop: 2 },
  logoutBtn: { paddingVertical: 6, borderRadius: 6, backgroundColor: "#f1f5f9" },
  logoutText: { color: "#ef4444", fontWeight: "700" },

  tabsContainer: { flexDirection: "row", paddingVertical: 12, backgroundColor: "#f1f5f9" },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: "#e2e8f0", alignItems: "center" },
  tabOn: { backgroundColor: "#1e293b" },
  tabText: { fontWeight: "700", color: "#475569" },
  tabTextOn: { color: "#ffffff" },

  title: { fontWeight: "800", color: "#0f172a", letterSpacing: -0.5 },
  subtitle: { color: "#64748b", fontWeight: "500" },
  sectionTitle: { fontWeight: "700", color: "#0f172a" },
  label: { fontWeight: "700", color: "#475569", marginTop: 16, marginBottom: 6, letterSpacing: 0.5 },
  textBold: { fontWeight: "700", color: "#0f172a" },
  textNormal: { color: "#334155", lineHeight: 20 },
  smallText: { fontSize: 12, color: "#64748b", marginTop: 4 },

  card: { backgroundColor: "#ffffff", borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0" },
  cardTitle: { fontWeight: "800", color: "#0f172a", marginBottom: 4 },
  cardReport: { backgroundColor: "#ffffff", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#e2e8f0" },
  cardReportTitle: { fontWeight: "700", color: "#0f172a", flex: 1, marginRight: 10 },
  cardError: { backgroundColor: "#fef2f2", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#fecaca" },
  emptyState: { padding: 30, alignItems: "center", backgroundColor: "#ffffff", borderRadius: 12, borderStyle: "dashed", borderWidth: 1, borderColor: "#cbd5e1" },

  input: { backgroundColor: "#f8fafc", borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 14, color: "#1e293b" },

  btn: { backgroundColor: "#1e293b", padding: 16, borderRadius: 8, alignItems: "center", marginTop: 24 },
  btnText: { color: "#ffffff", fontWeight: "700", letterSpacing: 0.5 },
  off: { opacity: 0.6 },
  btnSecondary: { backgroundColor: "#f1f5f9", borderWidth: 1, borderColor: "#e2e8f0", padding: 12, borderRadius: 8, alignItems: "center", marginTop: 8 },
  btnSecondaryHalf: { flex: 1, backgroundColor: "#f1f5f9", borderWidth: 1, borderColor: "#e2e8f0", padding: 14, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  btnSecondaryText: { color: "#334155", fontWeight: "600" },

  chips: { flexDirection: "row", flexWrap: "wrap" },
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: "#f1f5f9", borderWidth: 1, borderColor: "#e2e8f0" },
  chipOn: { backgroundColor: "#1e293b", borderColor: "#1e293b" },
  chipText: { color: "#475569", fontWeight: "600" },
  chipTextOn: { color: "#ffffff" },
  chipSmall: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: "#f1f5f9", borderWidth: 1, borderColor: "#e2e8f0" },
  chipTextSmall: { color: "#475569", fontWeight: "600", fontSize: 11 },

  badge: { fontWeight: "700", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, overflow: "hidden", textTransform: "uppercase" },
  bPend: { backgroundColor: "#fee2e2", color: "#b91c1c" },
  bWarn: { backgroundColor: "#fef3c7", color: "#b45309" },
  bOk: { backgroundColor: "#dcfce7", color: "#15803d" },

  preview: { width: "100%", borderRadius: 8, marginTop: 12, backgroundColor: "#e2e8f0", resizeMode: "cover" },
  previewReport: { width: "100%", borderRadius: 8, marginTop: 10, backgroundColor: "#f1f5f9", resizeMode: "cover" },

  row: { flexDirection: "row" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },

  msgOk: { color: "#059669", marginTop: 16, fontWeight: "600", fontSize: 14, textAlign: "center" },
  msgError: { color: "#dc2626", marginTop: 16, fontWeight: "600", fontSize: 14, textAlign: "center" },
  linkText: { color: "#2563eb", fontWeight: "600", fontSize: 14 },

  adminActions: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#f1f5f9" },

  securityTitle: { fontWeight: "700", color: "#92400e", marginBottom: 4 },
  btnSecondaryDark: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#fcd34d", padding: 12, borderRadius: 8, alignItems: "center", marginTop: 10 },
  btnSecondaryDarkText: { color: "#92400e", fontWeight: "700", fontSize: 13 },
  logContainer: { backgroundColor: "#1e293b", padding: 16, borderRadius: 8, marginTop: 12 },
  logTitle: { color: "#94a3b8", fontSize: 11, fontWeight: "700", marginBottom: 8, textTransform: "uppercase" },
  logText: { color: "#f8fafc", fontFamily: Platform.OS === "ios" ? "Courier" : "monospace", fontSize: 13, lineHeight: 20 },
});