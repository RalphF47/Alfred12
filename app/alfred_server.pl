#!/usr/bin/perl
# Alfred interface — a tiny local web server over Ralph's markdown files.
# Usage: perl app/alfred_server.pl        then open http://localhost:8765
# The markdown files stay the source of truth; this only reads and edits them.
use strict; use warnings; use utf8;
use HTTP::Daemon; use HTTP::Response;
use JSON::PP; use POSIX qw(strftime); use Time::Local qw(timelocal);
use File::Basename qw(dirname); use Cwd qw(abs_path);

$ENV{TZ} = 'America/Chicago'; POSIX::tzset();
my $ROOT = dirname(dirname(abs_path($0)));
my $PUB  = "$ROOT/app/public";
my $PORT = $ENV{ALFRED_PORT} || 8765;
my $JSON = JSON::PP->new->utf8->canonical;
my @MONTHS = qw(January February March April May June July August September October November December);
my @DOW = qw(Sun Mon Tue Wed Thu Fri Sat);
$| = 1;

# Listens on all interfaces, but only answers connections that arrive on this Mac itself (127.0.0.1)
# or over Tailscale (the Mac's own 100.64.0.0/10 address). Wi-Fi/LAN connections are dropped unread.
my $d = HTTP::Daemon->new(LocalAddr => '0.0.0.0', LocalPort => $PORT, ReuseAddr => 1)
  or die "Cannot listen on port $PORT: $!\n";
print "Alfred is running at http://localhost:$PORT  (Ctrl+C to stop)\n";

sub tailnet { my $ip = shift // ''; return $ip =~ /^100\.(\d+)\./ && $1 >= 64 && $1 <= 127 }
sub allowed_conn {
  my $c = shift; my ($local, $peer) = ($c->sockhost // '', $c->peerhost // '');
  return 1 if $local eq '127.0.0.1' && $peer eq '127.0.0.1';
  return 1 if tailnet($local) && tailnet($peer);
  return 0;
}

while (my $c = $d->accept) {
  unless (allowed_conn($c)) { $c->close; next }
  $c->timeout(10);
  if (my $r = $c->get_request) {
    my $res = eval { handle($r) };
    if (!$res) { my $e = $@ || 'unknown error'; $e =~ s/ at \S+ line \d+.*//s; warn "error: $e\n"; $res = json_res(400, { error => "$e" }) }
    $res->header('Connection' => 'close', 'X-Content-Type-Options' => 'nosniff');
    $c->send_response($res);
  }
  $c->close;
}

# ---------- routing ----------
sub handle {
  my $r = shift;
  my $host = $r->header('Host') // '';
  # Host check blocks DNS-rebinding tricks: only names that really point at this Mac.
  return text_res(403, 'Forbidden')
    unless $host =~ /^(localhost|127\.0\.0\.1|100\.\d+\.\d+\.\d+|[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net)(:\d+)?$/i;
  my $path = $r->uri->path; my $m = $r->method;

  if ($m eq 'GET') {
    my %static = ('/' => 'index.html', '/index.html' => 'index.html', '/app.js' => 'app.js', '/app.css' => 'app.css');
    return file_res("$PUB/$static{$path}") if $static{$path};
    return file_res("$ROOT/briefs/$1.html") if $path =~ m{^/briefs/(\d{4}-\d\d-\d\d)\.html$};
    return json_res(200, state()) if $path eq '/api/state';
    return text_res(404, 'Not found');
  }
  if ($m eq 'POST') {
    # JSON-only POSTs: browsers can't send these cross-site without a CORS preflight we never approve.
    return text_res(415, 'JSON only') unless ($r->header('Content-Type') // '') =~ m{^application/json};
    my $b = $JSON->decode($r->content || '{}');
    my %post = (
      '/api/tasks/toggle'      => \&task_toggle,
      '/api/tasks/add'         => \&task_add,
      '/api/tasks/delete'      => \&task_delete,
      '/api/calendar/add'      => \&cal_add,
      '/api/calendar/delete'   => \&cal_delete,
      '/api/inbox/add'         => \&inbox_add,
      '/api/inbox/remove'      => \&inbox_remove,
      '/api/inbox/to-task'     => \&inbox_to_task,
      '/api/projects/add'      => \&project_add,
      '/api/projects/toggle'   => \&project_toggle,
      '/api/projects/milestone'=> \&project_milestone,
    );
    my $fn = $post{$path} or return text_res(404, 'Not found');
    $fn->($b);
    return json_res(200, state());
  }
  return text_res(405, 'Method not allowed');
}

# ---------- helpers ----------
sub rd { my $f = shift; open my $fh, '<:encoding(UTF-8)', "$ROOT/$f" or return ''; local $/; my $s = <$fh>; close $fh; $s // '' }
sub wr {
  my ($f, $s) = @_; my $p = "$ROOT/$f"; my $t = "$p.tmp$$";
  open my $fh, '>:encoding(UTF-8)', $t or die "Cannot write $f\n"; print $fh $s; close $fh or die "Cannot write $f\n";
  rename $t, $p or die "Cannot save $f\n";
}
sub lines_of { my $s = rd(shift); return split /\n/, $s, -1 }
sub save_lines { my ($f, $L) = @_; wr($f, join("\n", @$L)) }
sub today { strftime('%Y-%m-%d', localtime) }
sub add_days { my ($ymd, $n) = @_; my ($y,$m,$dd) = split /-/, $ymd; strftime('%Y-%m-%d', localtime(timelocal(0,0,12,$dd,$m-1,$y) + $n*86400)) }
sub dow { my ($y,$m,$dd) = split /-/, shift; $DOW[(localtime(timelocal(0,0,12,$dd,$m-1,$y)))[6]] }
sub clean { my $s = shift // ''; $s =~ s/[\r\n]+/ /g; $s =~ s/^\s+|\s+$//g; $s }
sub valid_date { my $x = shift // ''; $x =~ /^\d{4}-\d\d-\d\d$/ }
sub clean_tag { my $t = clean(shift); $t =~ s/^#//; $t =~ s/[^\w-]//g; lc $t }
sub check_line { my ($L, $i, $raw) = @_;
  die "That item changed since the page loaded. Refresh and try again.\n"
    unless defined $i && $i =~ /^\d+$/ && $i <= $#$L && $L->[$i] eq ($raw // "\0") }

sub section_end {   # index to insert at the end of "## name" (before trailing blanks)
  my ($L, $name) = @_; my $h;
  for my $i (0..$#$L) { if ($L->[$i] =~ /^##\s+\Q$name\E\s*$/) { $h = $i; last } }
  return undef unless defined $h;
  my $j = $h + 1; $j++ while $j <= $#$L && $L->[$j] !~ /^## /;
  my $k = $j; $k-- while $k - 1 > $h && $L->[$k-1] =~ /^\s*$/;
  return $k;
}
sub header_idx { my ($L, $name) = @_; for my $i (0..$#$L) { return $i if $L->[$i] =~ /^##\s+\Q$name\E\s*$/ } undef }

# ---------- parsing ----------
sub parse_task {
  my ($t, $line) = @_;
  my ($mark, $body) = $t =~ /^\s*- \[([ xX])\]\s*(.*)$/ or return;
  my @tags = $body =~ /\(#([\w-]+)\)/g;
  my ($due) = $body =~ /\bdue (\d{4}-\d\d-\d\d)/;
  ($due) = $body =~ /— (\d{4}-\d\d-\d\d)/ unless $due;
  my ($done_on) = $body =~ /— done (\d{4}-\d\d-\d\d)/;
  my $flag = $body =~ /⚠️/ ? JSON::PP::true : JSON::PP::false;
  (my $text = $body) =~ s/\s*\(#[\w-]+\)//g; $text =~ s/⚠️\s*//g; $text =~ s/\s*— done \d{4}-\d\d-\d\d//; $text =~ s/\s*— due \d{4}-\d\d-\d\d//;
  return { line => $line, raw => $t, done => ($mark =~ /x/i ? JSON::PP::true : JSON::PP::false),
           text => $text, tags => \@tags, due => $due, done_on => $done_on, flag => $flag };
}

sub parse_tasks {
  my @L = lines_of('tasks.md'); my (@sections, $cur);
  for my $i (0..$#L) {
    if ($L[$i] =~ /^##\s+(.+?)\s*$/) { $cur = { name => $1, items => [] }; push @sections, $cur; next }
    next unless $cur;
    my $t = parse_task($L[$i], $i) or next;
    push @{$cur->{items}}, $t;
  }
  return \@sections;
}

sub parse_calendar {
  my @L = lines_of('calendar.md'); my @ev;
  for my $i (0..$#L) {
    my ($date, $rest) = $L[$i] =~ /^- (\d{4}-\d\d-\d\d)(?: \(\w+\))?\s*(.*)$/ or next;
    my ($time, $text) = $rest =~ /^(.*?)\s*—\s*(.*)$/ ? ($1, $2) : ('', $rest);
    my @tags = $text =~ /\(#([\w-]+)\)/g; $text =~ s/\s*\(#[\w-]+\)//g;
    push @ev, { line => $i, raw => $L[$i], date => $date, time => $time, text => $text, tags => \@tags };
  }
  return \@ev;
}

sub parse_canvas {
  my @L = lines_of('canvas.md'); my ($date, @items);
  my ($synced) = join("\n", @L) =~ /on (\d{4}-\d\d-\d\d \d\d:\d\d)/;
  for my $l (@L) {
    if ($l =~ /^## (\d{4}-\d\d-\d\d)/) { $date = $1; next }
    next unless $date && $l =~ /^- (.*?) — (.*?)(?: — \[open\]\((https:[^)]+)\))?$/;
    my ($when, $desc, $url) = ($1, $2, $3);
    my ($title, $course) = $desc =~ /^(.*?)\s*\[([^\]]*)\]/ ? ($1, $2) : ($desc, '');
    my ($code) = $course =~ /^([A-Z]{3,4})[ -]?(\d{3})/ ? ("$1 $2") : ('');
    push @items, { date => $date, when => $when, title => $title, course => $code, url => $url };
  }
  return { synced => $synced, items => \@items };
}

sub parse_inbox {
  my @L = lines_of('inbox.md'); my @items;
  for my $i (0..$#L) { next unless $L[$i] =~ /^\s*- (?:\[ \]\s*)?(.+)$/; push @items, { line => $i, raw => $L[$i], text => $1 } }
  return \@items;
}

sub parse_projects {
  my @out;
  opendir my $dh, "$ROOT/projects" or return [];
  for my $slug (sort grep { /^[a-z0-9-]+$/ && -f "$ROOT/projects/$_/README.md" } readdir $dh) {
    my @L = lines_of("projects/$slug/README.md");
    my %p = (slug => $slug, title => $slug, meta => {}, milestones => [], notes => []);
    for my $i (0..$#L) {
      my $l = $L[$i];
      if ($l =~ /^# (.+)/ && $p{title} eq $slug) { $p{title} = $1; next }
      if ($l =~ /^(Tag|Due|Status|Team|Keywords|Link):\s*(.*)$/) { $p{meta}{lc $1} = $2; next }
      if (my $t = parse_task($l, $i)) { push @{$p{milestones}}, $t; next }
      push @{$p{notes}}, $l;
    }
    my $notes = join("\n", @{$p{notes}}); $notes =~ s/^\s+|\s+$//g; $p{notes} = $notes;
    push @out, \%p;
  }
  closedir $dh; return \@out;
}

sub parse_schedule {
  my @L = lines_of('schedule.md'); my (@sections, $cur, %over);
  my %dn = (Sun=>0, Mon=>1, Tue=>2, Wed=>3, Thu=>4, Fri=>5, Sat=>6);
  for my $l (@L) {
    if ($l =~ /^##\s+(.+?)\s*$/) { $cur = { name => $1, skip => [], items => [] }; push @sections, $cur; next }
    next unless $cur;
    if ($cur->{name} =~ /^Day overrides/i) {
      $over{$1} = $dn{$2} if $l =~ /^- (\d{4}-\d\d-\d\d)\s*=\s*(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b/; next;
    }
    if ($l =~ /^Skip:\s*(.*)$/)  { $cur->{skip} = [ $1 =~ /(\d{4}-\d\d-\d\d)/g ]; next }
    if ($l =~ /^From:\s*(\d{4}-\d\d-\d\d)/)  { $cur->{from} = $1; next }
    if ($l =~ /^Until:\s*(\d{4}-\d\d-\d\d)/) { $cur->{until} = $1; next }
    my ($days, $start, $end, $text) = $l =~ /^- (\S+)\s+(\d{1,2}:\d\d)(?:\s*[–-]\s*(\d{1,2}:\d\d))?\s+—\s+(.*)$/ or next;
    my @d = $days eq 'Daily' ? (0..6) : $days eq 'Weekdays' ? (1..5) : $days eq 'Weekends' ? (0, 6)
          : map { $dn{$_} // () } split /,/, $days;
    my @tags = $text =~ /\(#([\w-]+)\)/g; $text =~ s/\s*\(#[\w-]+\)//g;
    push @{$cur->{items}}, { days => \@d, start => $start, end => $end, text => $text, tags => \@tags };
  }
  return { sections => [ grep { $_->{name} !~ /^Day overrides/i } @sections ], overrides => \%over };
}

sub list_briefs {
  opendir my $dh, "$ROOT/briefs" or return [];
  my @b = reverse sort map { /^(\d{4}-\d\d-\d\d)\.html$/ ? $1 : () } readdir $dh; closedir $dh; \@b;
}

sub state {
  return { today => today(), tasks => parse_tasks(), calendar => parse_calendar(), canvas => parse_canvas(),
           inbox => parse_inbox(), projects => parse_projects(), briefs => list_briefs(), schedule => parse_schedule() };
}

# ---------- tasks ----------
sub auto_section { my $due = shift; return 'Later' unless $due; my $t = today();
  return 'Today' if $due le $t; return 'This Week' if $due le add_days($t, 7); 'Later' }

sub insert_in_section {
  my ($L, $name, $line) = @_;
  my $k = section_end($L, $name);
  unless (defined $k) {
    my $dn = header_idx($L, 'Done') // scalar @$L;
    splice @$L, $dn, 0, "## $name", "";
    $k = $dn + 1;
  }
  splice @$L, $k, 0, $line;
}

sub build_task {
  my ($text, $due, $tag) = @_;
  my $s = "- [ ] $text"; $s .= " — due $due" if $due; $s .= " (#$tag)" if $tag; $s;
}

sub task_add {
  my $b = shift; my $text = clean($b->{text}) or die "Task needs a description.\n";
  my $due = valid_date($b->{due}) ? $b->{due} : undef; my $tag = clean_tag($b->{tag});
  my @L = lines_of('tasks.md');
  my $sec = clean($b->{section}); $sec = auto_section($due) if !$sec || $sec eq 'Auto';
  insert_in_section(\@L, $sec, build_task($text, $due, $tag));
  save_lines('tasks.md', \@L);
}

sub task_toggle {
  my $b = shift; my @L = lines_of('tasks.md'); check_line(\@L, $b->{line}, $b->{raw});
  my $t = splice @L, $b->{line}, 1;
  if ($t =~ /^\s*- \[ \]/) {
    $t =~ s/^\s*- \[ \]\s*/- [x] /; $t =~ s/⚠️\s*//g; $t =~ s/\s+(\(#[\w-]+\))\s*$/ — done @{[today()]} $1/ or $t .= ' — done ' . today();
    my $h = header_idx(\@L, 'Done');
    unless (defined $h) { push @L, '' if @L && $L[-1] ne ''; push @L, '## Done'; $h = $#L }
    splice @L, $h + 1, 0, $t;
  } else {
    $t =~ s/^\s*- \[[xX]\]\s*/- [ ] /; $t =~ s/\s*— done \d{4}-\d\d-\d\d//;
    my ($due) = $t =~ /\bdue (\d{4}-\d\d-\d\d)/;
    insert_in_section(\@L, auto_section($due), $t);
  }
  save_lines('tasks.md', \@L);
}

sub task_delete {
  my $b = shift; my @L = lines_of('tasks.md'); check_line(\@L, $b->{line}, $b->{raw});
  splice @L, $b->{line}, 1; save_lines('tasks.md', \@L);
}

# ---------- calendar ----------
sub cal_add {
  my $b = shift; my $date = $b->{date}; valid_date($date) or die "Pick a date.\n";
  my $text = clean($b->{text}) or die "Event needs a description.\n";
  my $time = clean($b->{time}); my $tag = clean_tag($b->{tag});
  my $line = "- $date (" . dow($date) . ")" . ($time ? " $time" : '') . " — $text" . ($tag ? " (#$tag)" : '');
  my @L = lines_of('calendar.md');
  my ($y, $m) = split /-/, $date; my $month = "$MONTHS[$m-1] $y";
  my $h = header_idx(\@L, $month);
  unless (defined $h) {
    my $at = scalar @L;
    for my $i (0..$#L) {
      next unless $L[$i] =~ /^## (\w+) (\d{4})\s*$/; my ($mn, $yy) = ($1, $2);
      my ($mi) = grep { $MONTHS[$_] eq $mn } 0..11; next unless defined $mi;
      if (sprintf('%04d-%02d', $yy, $mi+1) gt "$y-$m") { $at = $i; last }
    }
    if ($at == @L) { pop @L while @L && $L[-1] eq ''; push @L, '', "## $month", $line, ''; }
    else { splice @L, $at, 0, "## $month", $line, '' }
    return save_lines('calendar.md', \@L);
  }
  my $end = section_end(\@L, $month); my $at = $end;
  for my $i ($h+1 .. $end-1) { if ($L[$i] =~ /^- (\d{4}-\d\d-\d\d)/ && $1 gt $date) { $at = $i; last } }
  splice @L, $at, 0, $line; save_lines('calendar.md', \@L);
}

sub cal_delete {
  my $b = shift; my @L = lines_of('calendar.md'); check_line(\@L, $b->{line}, $b->{raw});
  splice @L, $b->{line}, 1; save_lines('calendar.md', \@L);
}

# ---------- inbox ----------
sub inbox_add {
  my $b = shift; my $text = clean($b->{text}) or die "Nothing to capture.\n";
  my @L = lines_of('inbox.md'); pop @L while @L && $L[-1] eq '';
  push @L, "- $text", ''; save_lines('inbox.md', \@L);
}
sub inbox_remove {
  my $b = shift; my @L = lines_of('inbox.md'); check_line(\@L, $b->{line}, $b->{raw});
  splice @L, $b->{line}, 1; save_lines('inbox.md', \@L);
}
sub inbox_to_task {
  my $b = shift; my @L = lines_of('inbox.md'); check_line(\@L, $b->{line}, $b->{raw});
  task_add({ text => $b->{text}, due => $b->{due}, tag => $b->{tag}, section => $b->{section} });
  splice @L, $b->{line}, 1; save_lines('inbox.md', \@L);
}

# ---------- projects ----------
sub proj_file { my $s = shift // ''; $s =~ /^[a-z0-9-]+$/ && -f "$ROOT/projects/$s/README.md" or die "Unknown project.\n"; "projects/$s/README.md" }
sub project_add {
  my $b = shift; my $name = clean($b->{name}) or die "Project needs a name.\n";
  (my $slug = lc $name) =~ s/[^a-z0-9]+/-/g; $slug =~ s/^-|-$//g; $slug = substr($slug, 0, 50) || 'project';
  die "A project with that name already exists.\n" if -e "$ROOT/projects/$slug";
  mkdir "$ROOT/projects/$slug" or die "Cannot create project folder.\n";
  my $due = valid_date($b->{due}) ? $b->{due} : ''; my $tag = clean_tag($b->{tag});
  my @c = ("# $name", "Status: Active");
  push @c, "Tag: #$tag" if $tag; push @c, "Due: $due" if $due; push @c, 'Team: ' . clean($b->{team}) if clean($b->{team});
  push @c, '', '## Goal', clean($b->{goal}) || '_What does done look like?_', '', '## Milestones', '', '## Notes', '';
  wr("projects/$slug/README.md", join("\n", @c));
}
sub project_toggle {
  my $b = shift; my $f = proj_file($b->{slug}); my @L = lines_of($f); check_line(\@L, $b->{line}, $b->{raw});
  $L[$b->{line}] =~ s/^(\s*- \[)([ xX])\]/$1 . ($2 eq ' ' ? 'x' : ' ') . ']'/e;
  save_lines($f, \@L);
}
sub project_milestone {
  my $b = shift; my $f = proj_file($b->{slug}); my $text = clean($b->{text}) or die "Milestone needs a description.\n";
  my $due = valid_date($b->{due}) ? $b->{due} : undef; my @L = lines_of($f);
  my $line = build_task($text, $due, '');
  my $k = section_end(\@L, 'Milestones');
  if (defined $k) { splice @L, $k, 0, $line } else { pop @L while @L && $L[-1] eq ''; push @L, '', '## Milestones', $line, '' }
  save_lines($f, \@L);
}

# ---------- responses ----------
sub json_res { my ($code, $data) = @_; my $r = HTTP::Response->new($code);
  $r->header('Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'); $r->content($JSON->encode($data)); $r }
sub text_res { my ($code, $msg) = @_; my $r = HTTP::Response->new($code); $r->header('Content-Type' => 'text/plain; charset=utf-8'); $r->content($msg); $r }
sub file_res {
  my $p = shift; open my $fh, '<:raw', $p or return text_res(404, 'Not found'); local $/; my $c = <$fh>; close $fh;
  my %ct = (html => 'text/html; charset=utf-8', js => 'text/javascript; charset=utf-8', css => 'text/css; charset=utf-8');
  my ($ext) = $p =~ /\.(\w+)$/; my $r = HTTP::Response->new(200);
  $r->header('Content-Type' => $ct{$ext} // 'application/octet-stream', 'Cache-Control' => 'no-store'); $r->content($c); $r;
}
