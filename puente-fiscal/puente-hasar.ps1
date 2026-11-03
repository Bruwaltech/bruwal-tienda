# ============================================================
#  Puente fiscal Hasar - Bruwal
#
#  La caja de Bruwal (en Chrome) no puede hablarle directo a la impresora
#  fiscal Hasar 2da generacion (SMH/PT-250F y similares). Este programita
#  queda abierto en la PC de la caja, escucha SOLO en esta PC
#  (http://127.0.0.1:12750) y le pasa a la Hasar los comandos de cada
#  venta, uno por uno, por HTTP (POST http://IP-DE-LA-HASAR/fiscal.json).
#
#  Si la Hasar esta enchufada por USB (puerto COM) y no por red, se usa el
#  "Proxy Fiscal HASAR" (http2pktw32ar.exe, programa oficial de Hasar):
#  el proxy toma el COM y escucha en 127.0.0.1:5000. En config.txt va
#  IP=127.0.0.1:5000 y FORMATO=xml (el proxy solo entiende XML).
#
#  La Hasar le informa a ARCA sola. Este programa no habla con ARCA.
#
#  Configuracion: config.txt, al lado de este archivo.
# ============================================================

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

$cfg = @{
  IP       = '192.168.1.1'
  CLAVE    = '9999'
  PUERTO   = '12750'
  FORMATO  = 'json'
  ORIGENES = 'https://bruwaltech.com.ar,https://www.bruwaltech.com.ar'
}
$cfgFile = Join-Path $dir 'config.txt'
if (Test-Path $cfgFile) {
  foreach ($linea in Get-Content $cfgFile) {
    if ($linea -match '^\s*([A-Z]+)\s*=\s*(.*?)\s*$') { $cfg[$matches[1]] = $matches[2] }
  }
}
$origenes = $cfg.ORIGENES.Split(',') | ForEach-Object { $_.Trim().TrimEnd('/') } | Where-Object { $_ }
$logFile = Join-Path $dir 'puente-hasar.log'
$xml = ($cfg.FORMATO.Trim().ToLower() -eq 'xml')

function Log($texto) {
  $l = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $texto
  Write-Host $l
  try { Add-Content -Path $logFile -Value $l -Encoding UTF8 } catch {}
}

# --- Hablar con la Hasar --------------------------------------------------
# La caja manda cada comando en JSON ({"Comando":{"Campo":valor}}). El
# Proxy Fiscal (USB) solo entiende XML: <Comando><Campo>valor</Campo></Comando>
function A-Xml([string]$nombre, $valor) {
  if ($valor -is [System.Management.Automation.PSCustomObject]) {
    $adentro = ''
    foreach ($pr in $valor.PSObject.Properties) { $adentro += (A-Xml $pr.Name $pr.Value) }
    if (-not $adentro) { return '<' + $nombre + '/>' }
    return '<' + $nombre + '>' + $adentro + '</' + $nombre + '>'
  }
  if ($valor -is [System.Array]) {
    $todo = ''
    foreach ($v in $valor) { $todo += (A-Xml $nombre $v) }
    return $todo
  }
  if ($valor -eq $null) { return '<' + $nombre + '></' + $nombre + '>' }
  if ($valor -is [bool]) { $valor = $(if ($valor) { 'true' } else { 'false' }) }
  $texto = [System.Security.SecurityElement]::Escape([string]$valor)
  return '<' + $nombre + '>' + $texto + '</' + $nombre + '>'
}

function Json-A-Xml([string]$json) {
  $o = ConvertFrom-Json $json
  $p = @($o.PSObject.Properties)[0]
  return '<?xml version="1.0" encoding="UTF-8"?>' + (A-Xml $p.Name $p.Value)
}

function Enviar-Hasar([string]$json) {
  if ($xml) {
    $url = 'http://' + $cfg.IP + '/fiscal.xml'
    $cuerpoTexto = Json-A-Xml $json
    $tipo = 'text/xml'
  } else {
    $url = 'http://' + $cfg.IP + '/fiscal.json'
    $cuerpoTexto = $json
    $tipo = 'application/json'
  }
  if ($xml) { return (Enviar-Crudo $cuerpoTexto $tipo) }
  $req = [System.Net.HttpWebRequest]::Create($url)
  $req.Method = 'POST'
  $req.ContentType = $tipo
  $req.Proxy = $null
  $req.Timeout = 30000
  $req.ReadWriteTimeout = 30000
  $req.Headers['Authorization'] = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(':' + $cfg.CLAVE))
  $bytes = [Text.Encoding]::UTF8.GetBytes($cuerpoTexto)
  $req.ContentLength = $bytes.Length
  $resp = $null
  try {
    $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
    $resp = $req.GetResponse()
  } catch {
    # PowerShell envuelve el error de .NET: el WebException esta adentro.
    $ex = $_.Exception
    while ($ex -and -not ($ex -is [System.Net.WebException]) -and $ex.InnerException) { $ex = $ex.InnerException }
    if (($ex -is [System.Net.WebException]) -and $ex.Response) { $resp = $ex.Response }
    else { return @{ ok = $false; red = $true; texto = $ex.Message; codigo = 0 } }
  }
  $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
  $texto = $sr.ReadToEnd(); $sr.Close()
  $codigo = [int]$resp.StatusCode
  $auth = [string]$resp.Headers['WWW-Authenticate']
  $resp.Close()
  $esHasar = Parece-Hasar $texto
  $ok = ($codigo -ge 200 -and $codigo -lt 300) -and $esHasar -and -not (Es-Error $texto)
  return @{ ok = $ok; red = $false; texto = $texto; codigo = $codigo; auth = $auth; esHasar = $esHasar }
}

# El Proxy Fiscal de Hasar contesta HTTP "a su manera" y .NET lo rechaza
# ("infraccion de protocolo, ResponseStatusLine"). Por eso con el proxy se
# habla a mano por el socket y se toma la respuesta como venga.
function Enviar-Crudo([string]$cuerpoTexto, [string]$tipo) {
  $hp = $cfg.IP.Split(':')
  $host1 = $hp[0]
  $puerto = 80
  if ($hp.Length -gt 1) { $puerto = [int]$hp[1] }
  $bytes = [Text.Encoding]::UTF8.GetBytes($cuerpoTexto)
  $cab = "POST /fiscal.xml HTTP/1.0`r`n" +
         "Host: " + $cfg.IP + "`r`n" +
         "Content-Type: " + $tipo + "`r`n" +
         "Authorization: Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(':' + $cfg.CLAVE)) + "`r`n" +
         "Content-Length: " + $bytes.Length + "`r`n" +
         "Connection: close`r`n`r`n"
  $cli = New-Object System.Net.Sockets.TcpClient
  try {
    $cli.Connect($host1, $puerto)
  } catch {
    $ex = $_.Exception; while ($ex.InnerException) { $ex = $ex.InnerException }
    return @{ ok = $false; red = $true; texto = $ex.Message; codigo = 0 }
  }
  $buf = New-Object System.IO.MemoryStream
  try {
    $st = $cli.GetStream()
    $cb = [Text.Encoding]::ASCII.GetBytes($cab)
    $st.Write($cb, 0, $cb.Length); $st.Write($bytes, 0, $bytes.Length); $st.Flush()
    # Hasta 40 s para la primera respuesta (la impresora puede tardar);
    # despues de que empieza a llegar, 2 s de silencio = termino.
    $st.ReadTimeout = 40000
    $tmp = New-Object byte[] 8192
    while ($true) {
      try { $n = $st.Read($tmp, 0, $tmp.Length) } catch { break }
      if ($n -le 0) { break }
      $buf.Write($tmp, 0, $n)
      $st.ReadTimeout = 2000
    }
  } finally { $cli.Close() }
  $raw = [Text.Encoding]::UTF8.GetString($buf.ToArray())
  if (-not $raw) { return @{ ok = $false; red = $true; texto = 'el Proxy Fiscal no contesto nada (puede que no haya podido abrir el COM)'; codigo = 0 } }
  $codigo = 200
  $texto = $raw
  if ($raw -match '^\s*HTTP/\d(\.\d)?\s+(\d{3})') { $codigo = [int]$matches[2] }
  $i = $raw.IndexOf('<')
  $j = $raw.IndexOf("`r`n`r`n"); $k = 4
  if ($j -lt 0) { $j = $raw.IndexOf("`n`n"); $k = 2 }
  if ($raw -match '^\s*HTTP/' -and $j -ge 0) { $texto = $raw.Substring($j + $k) }
  elseif ($i -gt 0) { $texto = $raw.Substring($i) }
  $esHasar = Parece-Hasar $texto
  if (-not $esHasar -and $texto.TrimStart().StartsWith('<')) { $esHasar = $true }
  $ok = ($codigo -ge 200 -and $codigo -lt 300) -and $esHasar -and -not (Es-Error $texto)
  return @{ ok = $ok; red = $false; texto = $texto; codigo = $codigo; auth = ''; esHasar = $esHasar }
}

# La Hasar contesta 200 tambien cuando el comando no se pudo hacer: el
# problema viene en la respuesta (un bloque de error con Identificador /
# Descripcion, o banderas de estado que empiezan con "Error").
function Es-Error([string]$t) {
  if (-not $t) { return $false }
  if ($t -match '"Identificador"') { return $true }
  if ($t -match '"Error[A-Za-z]*"\s*[,\]]') { return $true }
  if ($t -match '"ComandoInvalido"|"ComandoNoValido"|"CampoDeDatosInvalido"') { return $true }
  # Lo mismo cuando contesta en XML (Proxy Fiscal por USB).
  if ($t -match '<Identificador>') { return $true }
  if ($t -match '>\s*Error[A-Za-z]*\s*<') { return $true }
  if ($t -match '>\s*(ComandoInvalido|ComandoNoValido|CampoDeDatosInvalido)\s*<') { return $true }
  return $false
}

# La Hasar contesta JSON. Un router o cualquier otro aparato que este en
# esa IP contesta una pagina web (HTML) o pide usuario y contrasena: eso
# NO es la Hasar, aunque conteste. En JACI paso con 192.168.1.1 (el router).
function Parece-Hasar([string]$t) {
  if (-not $t) { return $false }
  $x = $t.TrimStart()
  return $x.StartsWith('{') -or $x.StartsWith('<?xml')
}

function Nombre-Comando([string]$json) {
  if ($json -match '^\s*\{\s*"([A-Za-z]+)"') { return $matches[1] }
  return '?'
}

function Explicar($r, [string]$cmd) {
  if ($r.red -and $xml) { return 'No se pudo conectar con el Proxy Fiscal Hasar en ' + $cfg.IP + ' (' + $r.texto + '). Revisa que la ventana "Proxy Fiscal Hasar" este abierta y que diga que abrio el COM.' }
  if ($r.red) { return 'No se pudo conectar con la Hasar en ' + $cfg.IP + ' (' + $r.texto + '). Revisa que este prendida, conectada y que la IP de config.txt sea la correcta.' }
  if (-not $r.esHasar) {
    $que = 'contesto otro aparato (HTTP ' + $r.codigo + ')'
    if ($r.auth) { return 'En ' + $cfg.IP + ' contesto un aparato que pide usuario y contrasena (' + $r.auth + '). Casi seguro es el router y no la Hasar: hay que poner en config.txt la IP de la Hasar.' }
    elseif ($r.texto -match '(?i)<html') { $que = 'contesto una pagina web' }
    return 'En ' + $cfg.IP + ' ' + $que + ': NO es la Hasar (seguramente es el router). Hay que poner en config.txt la IP de la Hasar.'
  }
  if ($r.codigo -eq 401 -or $r.codigo -eq 403) { return 'La Hasar rechazo la clave (CLAVE en config.txt).' }
  $detalle = $r.texto
  if ($detalle.Length -gt 400) { $detalle = $detalle.Substring(0, 400) + '...' }
  return 'La Hasar no acepto "' + $cmd + '" (HTTP ' + $r.codigo + '): ' + $detalle
}

function Imprimir($comandos, [bool]$sinCancelar) {
  $abierto = $false
  $numero = ''
  foreach ($c in $comandos) {
    $cmd = Nombre-Comando $c
    Log ('-> ' + $cmd)
    $r = Enviar-Hasar $c
    if (-not $r.ok) {
      Log ('   ERROR: ' + (Explicar $r $cmd))
      $msg = Explicar $r $cmd
      if ($abierto -and -not $sinCancelar) {
        Log '-> Cancelar (se anula el comprobante a medio hacer)'
        $rc = Enviar-Hasar '{"Cancelar":{}}'
        Log ('   ' + $rc.texto)
      }
      return @{ ok = $false; error = $msg; paso = $cmd }
    }
    if ($cmd -eq 'AbrirDocumento') { $abierto = $true }
    if ($cmd -eq 'CerrarDocumento') {
      $abierto = $false
      if ($r.texto -match '"NumeroComprobante"\s*:\s*"?(\d+)') { $numero = $matches[1] }
      elseif ($r.texto -match '<NumeroComprobante>\s*(\d+)') { $numero = $matches[1] }
    }
  }
  if ($numero) { Log ('   OK, comprobante N ' + $numero) } else { Log '   OK' }
  return @{ ok = $true; numero = $numero }
}

# --- Servidor HTTP minimo (solo 127.0.0.1) --------------------------------
function Leer-Pedido($stream) {
  $cab = New-Object System.IO.MemoryStream
  $ult = 0
  while ($true) {
    $b = $stream.ReadByte()
    if ($b -lt 0) { return $null }
    $cab.WriteByte([byte]$b)
    $ult = ($ult -shl 8) -bor $b
    if ($ult -eq 0x0D0A0D0A) { break }
    if ($cab.Length -gt 65536) { return $null }
  }
  $texto = [Text.Encoding]::ASCII.GetString($cab.ToArray())
  $lineas = $texto -split "`r`n"
  $partes = $lineas[0].Split(' ')
  $h = @{}
  foreach ($l in $lineas[1..($lineas.Length - 1)]) {
    $i = $l.IndexOf(':')
    if ($i -gt 0) { $h[$l.Substring(0, $i).Trim().ToLower()] = $l.Substring($i + 1).Trim() }
  }
  $cuerpo = ''
  if ($h.ContainsKey('content-length')) {
    $n = [int]$h['content-length']
    if ($n -gt 1048576) { return $null }
    $buf = New-Object byte[] $n
    $leidos = 0
    while ($leidos -lt $n) {
      $k = $stream.Read($buf, $leidos, $n - $leidos)
      if ($k -le 0) { break }
      $leidos += $k
    }
    $cuerpo = [Text.Encoding]::UTF8.GetString($buf, 0, $leidos)
  }
  return @{ metodo = $partes[0]; ruta = $partes[1]; cab = $h; cuerpo = $cuerpo }
}

function Responder($stream, [int]$codigo, $objeto, [string]$origen) {
  $json = ''
  if ($objeto -ne $null) { $json = ConvertTo-Json $objeto -Compress -Depth 5 }
  $cuerpo = [Text.Encoding]::UTF8.GetBytes($json)
  $estado = @{ 200 = 'OK'; 204 = 'No Content'; 403 = 'Forbidden'; 404 = 'Not Found'; 400 = 'Bad Request' }[$codigo]
  $cab = "HTTP/1.1 $codigo $estado`r`n" +
         "Content-Type: application/json; charset=utf-8`r`n" +
         "Content-Length: " + $cuerpo.Length + "`r`n" +
         "Connection: close`r`n"
  if ($origen) {
    $cab += "Access-Control-Allow-Origin: $origen`r`n" +
            "Vary: Origin`r`n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n" +
            "Access-Control-Allow-Headers: Content-Type`r`n" +
            "Access-Control-Allow-Private-Network: true`r`n" +
            "Access-Control-Allow-Local-Network: true`r`n"
  }
  $cab += "`r`n"
  $b = [Text.Encoding]::ASCII.GetBytes($cab)
  $stream.Write($b, 0, $b.Length)
  if ($cuerpo.Length) { $stream.Write($cuerpo, 0, $cuerpo.Length) }
  $stream.Flush()
}

function Atender($cliente) {
  $cliente.ReceiveTimeout = 15000
  $stream = $cliente.GetStream()
  $p = Leer-Pedido $stream
  if (-not $p) { return }
  $origen = $p.cab['origin']
  $permitido = (-not $origen) -or ($origenes -contains $origen.TrimEnd('/')) -or ($origen -match '^http://(localhost|127\.0\.0\.1)(:\d+)?$')
  if (-not $permitido) {
    Log ('Pedido rechazado de ' + $origen)
    Responder $stream 403 @{ ok = $false; error = 'Origen no permitido: ' + $origen } $null
    return
  }
  if ($p.metodo -eq 'OPTIONS') { Responder $stream 204 $null $origen; return }

  $ruta = $p.ruta.Split('?')[0]
  if ($p.metodo -eq 'GET' -and $ruta -eq '/estado') {
    $r = Enviar-Hasar '{"ConsultarEstado":{"CodigoComprobante":"TiqueFacturaB"}}'
    $muestra = [string]$r.texto; if ($muestra.Length -gt 300) { $muestra = $muestra.Substring(0, 300) }
    Log ('Probar conexion -> ' + $(if ($r.ok) { 'OK' } else { 'FALLO' }) + ': ' + $muestra)
    if ($r.red -or -not $r.esHasar) { Responder $stream 200 @{ ok = $false; ip = $cfg.IP; error = (Explicar $r 'ConsultarEstado') } $origen }
    else { Responder $stream 200 @{ ok = $true; ip = $cfg.IP; respuesta = $r.texto } $origen }
    return
  }
  if ($p.metodo -eq 'POST' -and $ruta -eq '/imprimir') {
    try { $datos = ConvertFrom-Json $p.cuerpo } catch { Responder $stream 400 @{ ok = $false; error = 'Pedido mal armado.' } $origen; return }
    $comandos = @($datos.comandos | ForEach-Object { [string]$_ })
    if (-not $comandos.Length) { Responder $stream 400 @{ ok = $false; error = 'No vino ningun comando.' } $origen; return }
    $res = Imprimir $comandos ([bool]$datos.sinCancelar)
    Responder $stream 200 $res $origen
    return
  }
  Responder $stream 404 @{ ok = $false; error = 'No existe ' + $ruta } $origen
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, [int]$cfg.PUERTO)
try { $listener.Start() } catch {
  Log ('No se pudo abrir el puerto ' + $cfg.PUERTO + '. Seguramente el puente ya esta abierto en otra ventana.')
  exit 1
}
$via = $(if ($xml) { 'Proxy Fiscal (USB) en ' } else { 'Hasar en ' })
Log ('Puente fiscal Hasar escuchando en http://127.0.0.1:' + $cfg.PUERTO + '  ->  ' + $via + $cfg.IP)
Log 'Deja esta ventana abierta (podes minimizarla) mientras uses la caja.'
while ($true) {
  $c = $listener.AcceptTcpClient()
  try { Atender $c } catch { Log ('Error: ' + $_.Exception.Message) } finally { $c.Close() }
}
