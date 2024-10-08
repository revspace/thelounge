export type ConfigTheme = {
	displayName: string;
	name: string;
	themeColor: string | null;
};

type NetworkTemplate = {
	host: string,
	port: number,
	tls: boolean,
	rejectUnauthorized: boolean // if TLS certificates are validated 
};

type SharedConfigurationBase = {
	public: boolean;
	useHexIp: boolean;
	prefetch: boolean;
	fileUpload: boolean;
	ldapEnabled: boolean;
	isUpdateAvailable: boolean;
	applicationServerKey: string;
	version: string;
	gitCommit: string | null;
	themes: ConfigTheme[];
	defaultTheme: string;
	fileUploadMaxFileSize?: number;
	networks: string[];
};

export type ConfigNetDefaults = {
	name: string;
	host: string;
	port: number;
	password: string;
	tls: boolean;
	rejectUnauthorized: boolean;
	nick: string;
	username: string;
	realname: string;
	join: string;
	leaveMessage: string;
	sasl: string;
	saslAccount: string;
	saslPassword: string;
};

export type LockedConfigNetDefaults = Pick<
	ConfigNetDefaults,
	"name" | "nick" | "username" | "password" | "realname" | "join"
>;

export type LockedSharedConfiguration = SharedConfigurationBase & {
	lockNetwork: true;
	defaults: LockedConfigNetDefaults;
};

export type SharedConfiguration = SharedConfigurationBase & {
	lockNetwork: false;
	defaults: ConfigNetDefaults;
};
